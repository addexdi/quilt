import {EventEmitter} from 'events';
import * as path from 'path';

import {DocumentNode, parse, Source, GraphQLSchema} from 'graphql';
import {extractImports} from '@sewing-kit/graphql';
import {mkdirp, readFile, writeFile} from 'fs-extra';
import {FSWatcher, watch} from 'chokidar';
import glob from 'globby';
import {loadConfig, GraphQLProjectConfig, GraphQLConfig} from 'graphql-config';

import {
  generateDocumentTypes,
  generateSchemaTypes,
  PrintSchemaOptions,
} from './print';
import type {DocumentDetails, ProjectDetails} from './types';

export interface RunOptions {
  watch?: boolean;
}

interface ProjectBuildStartDetails {
  project: GraphQLProjectConfig;
}

interface ProjectBuildEndDetails {
  project: GraphQLProjectConfig;
  schema: SchemaBuildDetails;
  documents: DocumentBuildDetails[];
}

interface SchemaBuildDetails {
  project: GraphQLProjectConfig;
  schema: GraphQLSchema;
  schemaTypes: SchemaTypeDefinition[];
}

interface DocumentBuildDetails {
  project: GraphQLProjectConfig;
  document: DocumentNode;
  documentPath: string;
  definitionPath: string;
  dependencies: Set<string>;
}

interface SchemaTypeDefinition {
  types: 'input';
  outputPath: string;
}

export interface GraphQLConfigExtensions {
  addTypename?: boolean;
  schemaTypes?: SchemaTypeDefinition[];
  customScalars?: PrintSchemaOptions['customScalars'];
}

type ProjectDetailsMap = Map<GraphQLProjectConfig, ProjectDetails>;

export async function createBuilder(cwd?: string) {
  const config = await loadConfig({
    rootDir: cwd,
    extensions: [() => ({name: 'quilt'})],
  });
  return new Builder(config!, cwd ?? process.cwd());
}

export class Builder extends EventEmitter {
  private watching = false;
  private readonly config: GraphQLConfig;
  private readonly projectDetails: ProjectDetailsMap = new Map();

  private get projects() {
    return Object.values(this.config.projects);
  }

  private readonly watchers: Set<FSWatcher> = new Set();

  constructor(config: GraphQLConfig, private readonly cwd: string) {
    super();
    this.config = config;
  }

  once(event: 'error', handler: (error: Error) => void): this;
  once(
    event: 'project:build:start',
    handler: (start: ProjectBuildStartDetails) => void,
  ): this;

  once(
    event: 'project:build:end',
    handler: (end: ProjectBuildEndDetails) => void,
  ): this;

  once(
    event: 'schema:build:end',
    handler: (built: SchemaBuildDetails) => void,
  ): this;

  once(
    event: 'document:build:end',
    handler: (built: DocumentBuildDetails) => void,
  ): this;

  once(event: string, handler: (...args: any[]) => void): this {
    return super.once(event, handler);
  }

  on(event: 'error', handler: (error: Error) => void): this;
  on(
    event: 'project:build:start',
    handler: (start: ProjectBuildStartDetails) => void,
  ): this;

  on(
    event: 'project:build:end',
    handler: (end: ProjectBuildEndDetails) => void,
  ): this;

  on(
    event: 'schema:build:end',
    handler: (built: SchemaBuildDetails) => void,
  ): this;

  on(
    event: 'document:build:end',
    handler: (built: DocumentBuildDetails) => void,
  ): this;

  on(event: string, handler: (...args: any[]) => void): this {
    return super.on(event, handler);
  }

  emit(event: 'error', error: Error): boolean;
  emit(event: 'project:build:start', start: ProjectBuildStartDetails): boolean;
  emit(event: 'project:build:end', end: ProjectBuildEndDetails): boolean;
  emit(event: 'schema:build:end', built: SchemaBuildDetails): boolean;
  emit(event: 'document:build:end', built: DocumentBuildDetails): boolean;
  emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  async watch() {
    this.watching = true;

    const updateDocument = async (
      filePath: string,
      project: GraphQLProjectConfig,
    ) => {
      try {
        await this.updateDocumentInProject(filePath, project);
      } catch (error) {
        this.emit('error', error);
      }
    };

    await this.run();

    if (!this.watching) return;

    for (const project of this.projects) {
      const documents = toArray(project.documents).filter(
        (document): document is string => typeof document === 'string',
      );

      if (documents.length === 0) continue;

      const schemasWatcher = watch(normalizeProjectSchemaPaths(project), {
        cwd: project.dirpath,
        ignoreInitial: true,
      }).on('update', () => this.updateProjectTypes(project));

      this.watchers.add(schemasWatcher);

      const documentsWatcher = watch(documents, {
        cwd: project.dirpath,
        ignored: toArray(project.exclude),
        ignoreInitial: true,
      })
        .on('add', (filePath: string) => updateDocument(filePath, project))
        .on('change', (filePath: string) => updateDocument(filePath, project))
        .on('unlink', async (filePath: string) => {
          this.projectDetails.get(project)?.documents.delete(filePath);
        });

      this.watchers.add(documentsWatcher);
    }

    // wait for all watchers to be ready
    await Promise.all(
      [...this.watchers].map(
        (watcher) =>
          new Promise((resolve) => watcher.on('ready', () => resolve())),
      ),
    );
  }

  async run() {
    try {
      await Promise.all(
        this.projects.map((project) => this.buildProjectTypes(project)),
      );
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  stop() {
    this.watching = false;

    for (const watcher of this.watchers) {
      watcher.close();
    }

    this.watchers.clear();
  }

  private async buildProjectTypes(project: GraphQLProjectConfig) {
    try {
      this.emit('project:build:start', {project});
      const schema = await this.buildSchemaTypes(project);
      const documents = await this.buildDocumentTypes(project);
      this.emit('project:build:end', {
        schema,
        documents,
        project,
      } as ProjectBuildEndDetails);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  private async updateProjectTypes(project: GraphQLProjectConfig) {
    try {
      await this.buildSchemaTypes(project);
      await Promise.all(
        [...this.projectDetails.get(project)!.documents.keys()].map((file) =>
          this.buildDocumentType(file, project),
        ),
      );
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  private async buildSchemaTypes(
    project: GraphQLProjectConfig,
  ): Promise<SchemaBuildDetails> {
    // GraphQL config (through @graphql-tools) handles loading and merging
    // multiple schema files. For now, this is fine, since we don’t support
    // a schema being loaded over the network. Once we do, though, we should
    // verify that we are comfortable with when this is getting called, since
    // network requests can have a big impact on developer experience for some
    // of the larger schemas at Shopify.
    const schema = await project.getSchema();

    const projectDetails = this.projectDetails.get(project);

    if (projectDetails) {
      projectDetails.schema = schema;
    } else {
      this.projectDetails.set(project, {
        schema,
        documents: new Map(),
      });
    }

    const {schemaTypes = []} = getOptions(project);

    if (schemaTypes.length === 0) {
      return {
        project,
        schema,
        schemaTypes,
      };
    }

    const generatedTypes = generateSchemaTypes(schema);

    await Promise.all(
      schemaTypes.map(async ({outputPath, types}) => {
        const isTypeFile = path.extname(outputPath) === '.ts';
        const finalOutputPath = path.resolve(
          project.dirpath,
          isTypeFile
            ? outputPath
            : path.join(
                outputPath,
                this.projects.length === 1
                  ? 'index.d.ts'
                  : `${project.name}.d.ts`,
              ),
        );
        await mkdirp(path.dirname(finalOutputPath));

        switch (types) {
          case 'input': {
            await writeFile(finalOutputPath, generatedTypes);
            break;
          }
        }
      }),
    );

    const details: SchemaBuildDetails = {
      project,
      schema,
      schemaTypes,
    };

    this.emit('schema:build:end', details);
    return details;
  }

  private async buildDocumentTypes(project: GraphQLProjectConfig) {
    const documentMap = this.projectDetails.get(project)!.documents;

    const documents = await glob(
      toArray(project.documents).filter(
        (document): document is string => typeof document === 'string',
      ),
      {
        absolute: true,
        cwd: project.dirpath,
        onlyFiles: true,
        ignore: toArray(project.exclude),
      },
    );

    await Promise.all(
      documents.map(async (filePath) => {
        await this.updateDocumentInProject(filePath, project);
      }),
    );

    const buildMap = new Map<string, Promise<DocumentBuildDetails>>();

    const load = (file: string) => {
      if (buildMap.has(file)) return buildMap.get(file)!;

      const promise = (async () => {
        const details = documentMap.get(file)!;
        await Promise.all([...details.dependencies].map(load));
        const buildDetails = await this.buildDocumentType(file, project);
        return buildDetails;
      })();

      buildMap.set(file, promise);
      return promise;
    };

    const results = await Promise.all([...documentMap.keys()].map(load));

    return results;
  }

  private async buildDocumentType(
    file: string,
    project: GraphQLProjectConfig,
  ): Promise<DocumentBuildDetails> {
    const {cwd} = this;
    const projectDetails = this.projectDetails.get(project)!;
    const documentDetails = projectDetails.documents.get(file)!;
    const definitionPath = `${file}.d.ts`;

    await writeFile(
      definitionPath,
      generateDocumentTypes(documentDetails, projectDetails, {
        importPath(type) {
          const {schemaTypes} = getOptions(project);

          if (schemaTypes == null || schemaTypes.length === 0) {
            throw new Error(
              `You must add at least one schemaTypes option when importing custom scalar or enum types in your query (encountered while importing type ${JSON.stringify(
                type.name,
              )})`,
            );
          }

          const {outputPath} = schemaTypes[0];

          return path.relative(
            path.dirname(file),
            path.resolve(cwd, outputPath),
          );
        },
      }),
    );

    const buildDetails: DocumentBuildDetails = {
      project,
      documentPath: file,
      definitionPath,
      ...documentDetails,
    };

    this.emit('document:build:end', buildDetails);

    return buildDetails;
  }

  private async updateDocumentInProject(
    filePath: string,
    project: GraphQLProjectConfig,
  ) {
    const contents = (await readFile(filePath, 'utf8')).trim();
    if (contents.length === 0) return;

    const documentMap = this.projectDetails.get(project)!.documents;
    const {imports, source} = extractImports(contents);
    const normalizedImport = imports.map((imported) =>
      path.join(path.dirname(filePath), imported),
    );

    for (const imported of normalizedImport) {
      const dependedOn = documentMap.get(imported);

      if (dependedOn?.dependencies.has(filePath)) {
        throw new Error(
          `Circular dependency detected between ${filePath} and ${imported}`,
        );
      }
    }

    const document = parse(new Source(source, filePath));

    const provides: DocumentDetails['provides'] = new Set();

    for (const definition of document.definitions) {
      switch (definition.kind) {
        case 'FragmentDefinition': {
          provides.add({
            type: 'fragment',
            name: definition.name.value,
          });
          break;
        }
        case 'OperationDefinition': {
          if (definition.operation === 'subscription') {
            break;
          }

          provides.add({
            type: definition.operation,
            name: definition.name?.value,
          });

          break;
        }
      }
    }

    documentMap.set(filePath, {
      path: filePath,
      provides,
      document,
      dependencies: new Set(normalizedImport),
    });
  }
}

function toArray<T>(value?: T | T[]): T[] {
  if (value == null) return [];
  if (Array.isArray(value)) return [];
  return [value];
}

function normalizeProjectSchemaPaths({schema, name}: GraphQLProjectConfig) {
  if (typeof schema === 'string') return [schema];
  if (Array.isArray(schema) && schema.every((file) => typeof file === 'string'))
    return schema as string[];

  throw new Error(
    `Can’t watch schema for GraphQL project ${JSON.stringify(
      name,
    )}: ${JSON.stringify(schema, null, 2)}`,
  );
}

function getOptions(project: GraphQLProjectConfig): GraphQLConfigExtensions {
  if (!project.hasExtension('quilt')) return {};
  return project.extension<GraphQLConfigExtensions>('quilt');
}
