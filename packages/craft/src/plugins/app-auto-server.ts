import {stripIndent} from 'common-tags';
import {createProjectPlugin} from '@quilted/sewing-kit';
import type {App, WaterfallHook} from '@quilted/sewing-kit';

import {MAGIC_MODULE_APP_ASSET_MANIFEST} from '../constants';

export interface AutoServerOptions {
  /**
   * Indicates that the auto-server build is being generated by `quilt`.
   */
  quiltAutoServer: boolean;
}

export interface AutoServerHooks {
  quiltAutoServerContent: WaterfallHook<string | undefined>;
  quiltAutoServerPort: WaterfallHook<number | undefined>;
  quiltAutoServerHost: WaterfallHook<string | undefined>;
}

declare module '@quilted/sewing-kit' {
  interface BuildAppOptions extends AutoServerOptions {}
  interface BuildAppConfigurationHooks extends AutoServerHooks {}
}

export function appAutoServer() {
  return createProjectPlugin<App>({
    name: 'Quilt.App.AutoServer',
    build({project, workspace, hooks, configure, run}) {
      hooks<AutoServerHooks>(({waterfall}) => ({
        quiltAutoServerHost: waterfall(),
        quiltAutoServerPort: waterfall(),
        quiltAutoServerContent: waterfall(),
      }));

      configure(
        (
          {
            outputDirectory,
            rollupPlugins,
            rollupOutputs,
            quiltAutoServerHost,
            quiltAutoServerPort,
            quiltAutoServerContent,
            quiltHttpHandlerHost,
            quiltHttpHandlerPort,
            quiltHttpHandlerContent,
          },
          {quiltAutoServer = false},
        ) => {
          if (!quiltAutoServer) return;

          quiltHttpHandlerHost?.(async () =>
            quiltAutoServerHost!.run(undefined),
          );

          quiltHttpHandlerPort?.(async () =>
            quiltAutoServerPort!.run(undefined),
          );

          quiltHttpHandlerContent?.(
            async () =>
              (await quiltAutoServerContent!.run(undefined)) ??
              `export {default} from '@quilted/quilt/magic-app-http-handler';`,
          );

          rollupPlugins?.(async (plugins) => {
            plugins.push({
              name: '@quilted/magic-module/asset-manifest',
              async resolveId(id) {
                if (id === MAGIC_MODULE_APP_ASSET_MANIFEST) return id;
                return null;
              },
              async load(source) {
                if (source !== MAGIC_MODULE_APP_ASSET_MANIFEST) return null;

                return stripIndent`
                  const AsyncAssets = {
                    styles: () => Promise.resolve([]),
                    scripts: () => Promise.resolve([]),
                    asyncAssets: () => Promise.resolve([]),
                  };

                  export default AsyncAssets;
                `;
              },
            });

            return plugins;
          });

          rollupOutputs?.(async (outputs) => [
            ...outputs,
            {
              format: 'esm',
              entryFileNames: 'index.js',
              dir: await outputDirectory.run(
                workspace.fs.buildPath(
                  workspace.apps.length > 1 ? `apps/${project.name}` : 'app',
                  'server',
                ),
              ),
            },
          ]);
        },
      );

      run((step, {configuration}) =>
        step({
          name: 'Quilt.App.AutoServer',
          label: `Build app ${project.name}`,
          async run() {
            const [configure, {buildWithRollup}] = await Promise.all([
              configuration({quiltAutoServer: true, quiltHttpHandler: true}),
              import('@quilted/sewing-kit-rollup'),
            ]);

            await buildWithRollup(configure);
          },
        }),
      );
    },
  });
}
