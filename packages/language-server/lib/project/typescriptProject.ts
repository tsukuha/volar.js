import { FileType, Language, LanguagePlugin, ProjectContext, ProviderResult, UriMap, createUriMap } from '@volar/language-service';
import * as path from 'path-browserify';
import type * as ts from 'typescript';
import * as vscode from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import type { LanguageServer, LanguageServerProject } from '../types';
import { getInferredCompilerOptions } from './inferredCompilerOptions';
import { createLanguageServiceEnvironment } from './simpleProject';
import { ProjectExposeContext, createTypeScriptLS, type TypeScriptProjectLS } from './typescriptProjectLs';

const rootTsConfigNames = ['tsconfig.json', 'jsconfig.json'];

export function createTypeScriptProject(
	ts: typeof import('typescript'),
	tsLocalized: ts.MapLike<string> | undefined,
	create: (projectContext: ProjectExposeContext) => ProviderResult<{
		languagePlugins: LanguagePlugin<URI>[];
		setup(options: {
			language: Language;
			project: ProjectContext;
		}): void;
	}>
) {
	let server: LanguageServer;
	let uriConverter: ReturnType<typeof createUriConverter>;

	const configProjects = createUriMap<Promise<TypeScriptProjectLS>>();
	const inferredProjects = createUriMap<Promise<TypeScriptProjectLS>>();
	const rootTsConfigs = new Set<string>();
	const searchedDirs = new Set<string>();
	const projects: LanguageServerProject = {
		setup(_server) {
			uriConverter = createUriConverter([..._server.workspaceFolders.keys()]);
			server = _server;
			server.onDidChangeWatchedFiles(({ changes }) => {
				const tsConfigChanges = changes.filter(change => rootTsConfigNames.includes(change.uri.substring(change.uri.lastIndexOf('/') + 1)));

				for (const change of tsConfigChanges) {
					const changeUri = URI.parse(change.uri);
					const changeFileName = uriConverter.asFileName(changeUri);
					if (change.type === vscode.FileChangeType.Created) {
						rootTsConfigs.add(changeFileName);
					}
					else if ((change.type === vscode.FileChangeType.Changed || change.type === vscode.FileChangeType.Deleted) && configProjects.has(changeUri)) {
						if (change.type === vscode.FileChangeType.Deleted) {
							rootTsConfigs.delete(changeFileName);
						}
						const project = configProjects.get(changeUri);
						configProjects.delete(changeUri);
						project?.then(project => project.dispose());
					}
				}

				if (tsConfigChanges.length) {
					server.clearPushDiagnostics();
				}
				server.refresh(projects);
			});
		},
		async getLanguageService(uri) {
			const tsconfig = await findMatchTSConfig(server, uri);
			if (tsconfig) {
				const project = await getOrCreateConfiguredProject(server, tsconfig);
				return project.languageService;
			}
			const workspaceFolder = getWorkspaceFolder(uri, server.workspaceFolders);
			const project = await getOrCreateInferredProject(server, uri, workspaceFolder);
			return project.languageService;
		},
		async getExistingLanguageServices() {
			const projects = await Promise.all([
				...configProjects.values() ?? [],
				...inferredProjects.values() ?? [],
			]);
			return projects.map(project => project.languageService);
		},
		reload() {
			for (const project of [
				...configProjects.values() ?? [],
				...inferredProjects.values() ?? [],
			]) {
				project.then(p => p.dispose());
			}
			configProjects.clear();
			inferredProjects.clear();
		},
	};
	return projects;

	async function findMatchTSConfig(server: LanguageServer, uri: URI) {

		const fileName = uriConverter.asFileName(uri);

		let dir = path.dirname(fileName);

		while (true) {
			if (searchedDirs.has(dir)) {
				break;
			}
			searchedDirs.add(dir);
			for (const tsConfigName of rootTsConfigNames) {
				const tsconfigPath = path.join(dir, tsConfigName);
				if ((await server.fs.stat?.(uriConverter.asUri(tsconfigPath)))?.type === FileType.File) {
					rootTsConfigs.add(tsconfigPath);
				}
			}
			dir = path.dirname(dir);
		}

		await prepareClosestootParsedCommandLine();

		return await findDirectIncludeTsconfig() ?? await findIndirectReferenceTsconfig();

		async function prepareClosestootParsedCommandLine() {

			let matches: string[] = [];

			for (const rootTsConfig of rootTsConfigs) {
				if (isFileInDir(fileName, path.dirname(rootTsConfig))) {
					matches.push(rootTsConfig);
				}
			}

			matches = matches.sort((a, b) => sortTSConfigs(fileName, a, b));

			if (matches.length) {
				await getParsedCommandLine(matches[0]);
			}
		}
		function findIndirectReferenceTsconfig() {
			return findTSConfig(async tsconfig => {
				const tsconfigUri = uriConverter.asUri(tsconfig);
				const project = await configProjects.get(tsconfigUri);
				return project?.askedFiles.has(uri) ?? false;
			});
		}
		function findDirectIncludeTsconfig() {
			return findTSConfig(async tsconfig => {
				const map = createUriMap<boolean>();
				const parsedCommandLine = await getParsedCommandLine(tsconfig);
				for (const fileName of parsedCommandLine?.fileNames ?? []) {
					const uri = uriConverter.asUri(fileName);
					map.set(uri, true);
				}
				return map.has(uri);
			});
		}
		async function findTSConfig(match: (tsconfig: string) => Promise<boolean> | boolean) {

			const checked = new Set<string>();

			for (const rootTsConfig of [...rootTsConfigs].sort((a, b) => sortTSConfigs(fileName, a, b))) {
				const tsconfigUri = uriConverter.asUri(rootTsConfig);
				const project = await configProjects.get(tsconfigUri);
				if (project) {

					let chains = await getReferencesChains(project.getParsedCommandLine(), rootTsConfig, []);

					// This is to be consistent with tsserver behavior
					chains = chains.reverse();

					for (const chain of chains) {
						for (let i = chain.length - 1; i >= 0; i--) {
							const tsconfig = chain[i];

							if (checked.has(tsconfig)) {
								continue;
							}
							checked.add(tsconfig);

							if (await match(tsconfig)) {
								return tsconfig;
							}
						}
					}
				}
			}
		}
		async function getReferencesChains(parsedCommandLine: ts.ParsedCommandLine, tsConfig: string, before: string[]) {

			if (parsedCommandLine.projectReferences?.length) {

				const newChains: string[][] = [];

				for (const projectReference of parsedCommandLine.projectReferences) {

					let tsConfigPath = projectReference.path.replace(/\\/g, '/');

					// fix https://github.com/johnsoncodehk/volar/issues/712
					if ((await server.fs.stat?.(uriConverter.asUri(tsConfigPath)))?.type === FileType.File) {
						const newTsConfigPath = path.join(tsConfigPath, 'tsconfig.json');
						const newJsConfigPath = path.join(tsConfigPath, 'jsconfig.json');
						if ((await server.fs.stat?.(uriConverter.asUri(newTsConfigPath)))?.type === FileType.File) {
							tsConfigPath = newTsConfigPath;
						}
						else if ((await server.fs.stat?.(uriConverter.asUri(newJsConfigPath)))?.type === FileType.File) {
							tsConfigPath = newJsConfigPath;
						}
					}

					const beforeIndex = before.indexOf(tsConfigPath); // cycle
					if (beforeIndex >= 0) {
						newChains.push(before.slice(0, Math.max(beforeIndex, 1)));
					}
					else {
						const referenceParsedCommandLine = await getParsedCommandLine(tsConfigPath);
						if (referenceParsedCommandLine) {
							for (const chain of await getReferencesChains(referenceParsedCommandLine, tsConfigPath, [...before, tsConfig])) {
								newChains.push(chain);
							}
						}
					}
				}

				return newChains;
			}
			else {
				return [[...before, tsConfig]];
			}
		}
		async function getParsedCommandLine(tsConfig: string) {
			const project = await getOrCreateConfiguredProject(server, tsConfig);
			return project?.getParsedCommandLine();
		}
	}

	function getOrCreateConfiguredProject(server: LanguageServer, tsconfig: string) {
		tsconfig = tsconfig.replace(/\\/g, '/');
		const tsconfigUri = uriConverter.asUri(tsconfig);
		let projectPromise = configProjects.get(tsconfigUri);
		if (!projectPromise) {
			const workspaceFolder = getWorkspaceFolder(tsconfigUri, server.workspaceFolders);
			const serviceEnv = createLanguageServiceEnvironment(server, [workspaceFolder]);
			projectPromise = createTypeScriptLS(
				ts,
				tsLocalized,
				tsconfig,
				server,
				serviceEnv,
				workspaceFolder,
				uriConverter,
				create
			);
			configProjects.set(tsconfigUri, projectPromise);
		}
		return projectPromise;
	}

	async function getOrCreateInferredProject(server: LanguageServer, uri: URI, workspaceFolder: URI) {

		if (!inferredProjects.has(workspaceFolder)) {
			inferredProjects.set(workspaceFolder, (async () => {
				const inferOptions = await getInferredCompilerOptions(server);
				const serviceEnv = createLanguageServiceEnvironment(server, [workspaceFolder]);
				return createTypeScriptLS(
					ts,
					tsLocalized,
					inferOptions,
					server,
					serviceEnv,
					workspaceFolder,
					uriConverter,
					create
				);
			})());
		}

		const project = await inferredProjects.get(workspaceFolder)!;

		project.tryAddFile(uriConverter.asFileName(uri));

		return project;
	}
}

export function createUriConverter(rootFolders: URI[]) {
	const encodeds = new Map<string, URI>();
	const isFileScheme = rootFolders.every(folder => folder.scheme === 'file');

	return {
		asFileName,
		asUri,
	};

	function asFileName(parsed: URI) {
		if (rootFolders.every(folder => folder.scheme === parsed.scheme && folder.authority === parsed.authority)) {
			if (isFileScheme) {
				return parsed.fsPath.replace(/\\/g, '/');
			}
			else {
				return parsed.path;
			}
		}
		const encoded = encodeURIComponent(`${parsed.scheme}://${parsed.authority}`);
		encodeds.set(encoded, parsed);
		return `/${encoded}${parsed.path}`;
	}

	function asUri(fileName: string) {
		for (const [encoded, uri] of encodeds) {
			const prefix = `/${encoded}`;
			if (fileName === prefix) {
				return URI.from({
					scheme: uri.scheme,
					authority: uri.authority,
				});
			}
			if (uri.authority) {
				if (fileName.startsWith(prefix + '/')) {
					return URI.from({
						scheme: uri.scheme,
						authority: uri.authority,
						path: fileName.substring(prefix.length),
					});
				}
			}
			else {
				if (fileName.startsWith(prefix)) {
					return URI.from({
						scheme: uri.scheme,
						authority: uri.authority,
						path: fileName.substring(prefix.length),
					});
				}
			}
		}
		if (!isFileScheme) {
			for (const folder of rootFolders) {
				return URI.parse(`${folder.scheme}://${folder.authority}${fileName}`);
			}
		}
		return URI.file(fileName);
	}
}

export function sortTSConfigs(file: string, a: string, b: string) {

	const inA = isFileInDir(file, path.dirname(a));
	const inB = isFileInDir(file, path.dirname(b));

	if (inA !== inB) {
		const aWeight = inA ? 1 : 0;
		const bWeight = inB ? 1 : 0;
		return bWeight - aWeight;
	}

	const aLength = a.split('/').length;
	const bLength = b.split('/').length;

	if (aLength === bLength) {
		const aWeight = path.basename(a) === 'tsconfig.json' ? 1 : 0;
		const bWeight = path.basename(b) === 'tsconfig.json' ? 1 : 0;
		return bWeight - aWeight;
	}

	return bLength - aLength;
}

export function isFileInDir(fileName: string, dir: string) {
	const relative = path.relative(dir, fileName);
	return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function getWorkspaceFolder(uri: URI, workspaceFolders: UriMap<boolean>) {
	while (true) {
		if (workspaceFolders.has(uri)) {
			return uri;
		}
		const next = uri.with({ path: uri.path.substring(0, uri.path.lastIndexOf('/')) });
		if (next.path === uri.path) {
			break;
		}
		uri = next;
	}

	for (const folder of workspaceFolders.keys()) {
		return folder;
	}

	return uri.with({ path: '/' });
}
