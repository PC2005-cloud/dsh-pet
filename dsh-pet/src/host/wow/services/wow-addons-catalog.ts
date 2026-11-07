import type { BaseIssue, BaseSchema, InferOutput } from 'valibot';

import type {
  AddonFile,
  AddonGame,
  AddonMetadata,
  AddonSearchRequest,
  AddonSearchResult,
  AddonSummary,
} from '../shared/wow-addons';

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import * as v from 'valibot';

const idSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(0xffffffff));
const countSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
const dateSchema = v.pipe(v.string(), v.isoTimestamp());
const categorySchema = v.object({
  id: idSchema,
  gameId: v.literal(1),
  name: v.string(),
  slug: v.string(),
  classId: v.nullable(idSchema),
  parentCategoryId: v.nullable(countSchema),
});
const versionTypeSchema = v.object({
  id: idSchema,
  gameId: v.literal(1),
  name: v.string(),
  slug: v.string(),
});
const modSchema = v.object({
  id: idSchema,
  gameId: v.literal(1),
  classId: v.literal(1),
  name: v.string(),
  summary: v.string(),
  logo: v.nullable(v.object({ thumbnailUrl: v.string() })),
  links: v.object({ websiteUrl: v.string() }),
  downloadCount: v.pipe(v.number(), v.finite(), v.minValue(0)),
  dateModified: dateSchema,
  authors: v.array(v.object({ name: v.string() })),
  categories: v.array(v.object({ id: idSchema })),
  allowModDistribution: v.nullable(v.boolean()),
});
const fileSchema = v.object({
  id: idSchema,
  gameId: v.literal(1),
  modId: idSchema,
  isAvailable: v.boolean(),
  displayName: v.string(),
  fileName: v.string(),
  fileLength: countSchema,
  releaseType: v.picklist([1, 2, 3]),
  fileDate: dateSchema,
  gameVersions: v.array(v.string()),
  sortableGameVersions: v.array(v.object({ gameVersionTypeId: v.nullable(idSchema) })),
  downloadUrl: v.nullable(v.string()),
  hashes: v.array(v.object({ algo: v.number(), value: v.string() })),
  dependencies: v.array(v.object({ modId: idSchema, relationType: v.number() })),
});
const paginationSchema = v.object({ index: countSchema, pageSize: countSchema, totalCount: countSchema });
const categoriesResponseSchema = v.object({ data: v.array(categorySchema) });
const versionTypesResponseSchema = v.object({ data: v.array(versionTypeSchema) });
const modResponseSchema = v.object({ data: modSchema });
const searchResponseSchema = v.object({ data: v.array(modSchema), pagination: paginationSchema });
const filesResponseSchema = v.object({ data: v.array(fileSchema), pagination: paginationSchema });
const fileResponseSchema = v.object({ data: fileSchema });
const latestFilesResponseSchema = v.object({
  data: v.object({
    id: idSchema,
    gameId: v.literal(1),
    classId: v.literal(1),
    latestFiles: v.array(fileSchema),
  }),
});
const downloadResponseSchema = v.object({ data: v.nullable(v.string()) });

/** Archive bytes stay bounded before extraction. Metadata responses use a separate 8 MiB limit. */
const maxDownloadBytes = 100 * 1024 * 1024;

class CatalogError extends Error {}

function fail(code: string): never {
  throw new CatalogError(`curseforge-${code}`);
}

function assertId(id: number) {
  if (!v.is(idSchema, id)) fail('invalid-request');
}

function versionGroup(name: string, slug: string): AddonGame | null {
  const label = `${name} ${slug}`.toLowerCase();
  if (label.includes('forever')) return 'forever';
  if (label.includes('retail')) return 'retail';
  if (label.includes('classic')) return 'classic';
  return null;
}

function publicLink(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      [...url.searchParams.keys()].some((key) => /api[-_]?key/i.test(key))
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function summary(mod: InferOutput<typeof modSchema>): AddonSummary {
  const website = publicLink(mod.links.websiteUrl);
  const logo = mod.logo && publicLink(mod.logo.thumbnailUrl);
  const trustedWebsite =
    website &&
    ['www.curseforge.com', 'curseforge.com'].includes(website.hostname) &&
    /^\/wow\/addons\/[a-z0-9-]+\/?$/i.test(website.pathname);
  const trustedLogo = logo && (logo.hostname === 'forgecdn.net' || logo.hostname.endsWith('.forgecdn.net'));
  return {
    id: mod.id,
    name: mod.name,
    summary: mod.summary,
    // Invalid optional links stay absent. The renderer disables the project action for an empty URL.
    logoUrl: trustedLogo ? logo.href : null,
    websiteUrl: trustedWebsite ? website.href : '',
    downloadCount: mod.downloadCount,
    dateModified: mod.dateModified,
    authors: mod.authors.map((author) => author.name),
    categories: mod.categories.map((category) => category.id),
    // A null distribution flag means the author has no explicit restriction.
    allowDistribution: mod.allowModDistribution !== false,
  };
}

function addonFile(file: InferOutput<typeof fileSchema>): AddonFile {
  return {
    id: file.id,
    modId: file.modId,
    displayName: file.displayName,
    fileName: file.fileName,
    fileLength: file.fileLength,
    releaseType: file.releaseType,
    fileDate: file.fileDate,
    gameVersions: file.gameVersions,
    gameVersionTypeIds: [
      ...new Set(
        file.sortableGameVersions.flatMap((version) =>
          version.gameVersionTypeId === null ? [] : [version.gameVersionTypeId],
        ),
      ),
    ],
    downloadUrl: file.downloadUrl === null ? null : downloadUrl(file.downloadUrl).href,
    sha1: file.hashes.find((hash) => hash.algo === 1 && /^[a-f0-9]{40}$/i.test(hash.value))?.value.toLowerCase(),
    dependencies: file.dependencies
      .filter((dependency) => dependency.relationType === 2 || dependency.relationType === 3)
      .map((dependency) => ({ modId: dependency.modId, required: dependency.relationType === 3 })),
  };
}

function downloadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('unsafe-download-url');
  }
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'forgecdn.net' && !url.hostname.endsWith('.forgecdn.net')) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !url.pathname.startsWith('/files/') ||
    [...url.searchParams.keys()].some((key) => /api[-_]?key/i.test(key))
  ) {
    fail('unsafe-download-url');
  }
  return url;
}

async function readBytes(response: Response, maximum: number): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await response.body?.cancel();
    fail('response-too-large');
  }
  if (!response.body) fail('invalid-response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        fail('response-too-large');
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Keeps the CurseForge key in the main process and validates API and CDN responses.
 * Metadata is cached per instance. Failed reads clear the cache, so a later request can retry.
 * API and download requests have separate deadlines. Redirects never receive the key before URL validation.
 * Disposal aborts pending requests and prevents new requests from starting.
 */
export class CurseForgeCatalog {
  private metadata: Promise<AddonMetadata> | null = null;
  private readonly lifetime = new AbortController();

  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    if (!apiKey.trim()) fail('api-key-required');
  }

  /** Stops pending network operations when the owning service shuts down or replaces this key. */
  dispose() {
    this.lifetime.abort();
    this.metadata = null;
  }

  async getMetadata(): Promise<AddonMetadata> {
    if (this.lifetime.signal.aborted) fail('disposed');
    if (!this.metadata) {
      this.metadata = this.loadMetadata().catch((error) => {
        this.metadata = null;
        throw error;
      });
    }
    // Return a copy so consumers cannot change later compatibility decisions.
    return structuredClone(await this.metadata);
  }

  async search(request: AddonSearchRequest): Promise<AddonSearchResult> {
    const metadata = await this.getMetadata();
    if (
      !metadata.versionTypes.some((type) => type.id === request.gameVersionTypeId && type.group === request.game) ||
      !Number.isSafeInteger(request.index) ||
      request.index < 0 ||
      request.index > 9980 ||
      typeof request.search !== 'string' ||
      request.search.length > 200 ||
      !['popular', 'updated', 'downloads'].includes(request.sort) ||
      (request.categoryId !== undefined && !metadata.categories.some((category) => category.id === request.categoryId))
    ) {
      fail('invalid-request');
    }
    const query = new URLSearchParams({
      gameId: '1',
      classId: '1',
      gameVersionTypeId: String(request.gameVersionTypeId),
      searchFilter: request.search.trim(),
      index: String(request.index),
      pageSize: '20',
      sortField: String({ popular: 2, updated: 3, downloads: 6 }[request.sort]),
      sortOrder: 'desc',
    });
    if (request.categoryId !== undefined) query.set('categoryId', String(request.categoryId));
    const response = await this.request(`/mods/search?${query}`, searchResponseSchema);
    if (response.data.length > 20 || response.pagination.index !== request.index || response.pagination.pageSize > 20)
      fail('invalid-response');
    return {
      addons: response.data.map(summary),
      index: response.pagination.index,
      pageSize: response.pagination.pageSize,
      totalCount: Math.min(response.pagination.totalCount, 10000),
    };
  }

  /** Returns available files for the exact discovered version type. Other flavors never enter the result. */
  async getFiles(modId: number, gameVersionTypeId: number): Promise<AddonFile[]> {
    assertId(modId);
    const metadata = await this.getMetadata();
    if (!metadata.versionTypes.some((type) => type.id === gameVersionTypeId)) fail('incompatible-version');
    const files: AddonFile[] = [];
    // The API exposes no file sort parameter. Read every page before selecting the latest files.
    for (let index = 0; index < 400; index += 20) {
      const response = await this.request(
        `/mods/${modId}/files?gameVersionTypeId=${gameVersionTypeId}&pageSize=20&index=${index}`,
        filesResponseSchema,
      );
      if (response.data.length > 20 || response.pagination.index !== index || response.pagination.pageSize > 20)
        fail('invalid-response');
      if (response.pagination.totalCount > 400) {
        // Large histories use the API's latest files to bound browsing requests.
        // This permanent resource policy omits old releases and preserves exact flavor checks.
        const latest = await this.request(`/mods/${modId}`, latestFilesResponseSchema);
        if (latest.data.id !== modId) fail('invalid-response');
        const compatible = latest.data.latestFiles
          .filter((file) => file.isAvailable && file.modId === modId)
          .map(addonFile)
          .filter((file) => file.gameVersionTypeIds.includes(gameVersionTypeId))
          .sort((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate))
          .slice(0, 20);
        if (!compatible.length) fail('too-many-files');
        return compatible;
      }
      files.push(
        ...response.data
          .filter((file) => file.isAvailable && file.modId === modId)
          .map(addonFile)
          .filter((file) => file.gameVersionTypeIds.includes(gameVersionTypeId)),
      );
      if (index + 20 >= response.pagination.totalCount)
        return files.sort((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate)).slice(0, 20);
      if (!response.data.length) fail('invalid-response');
    }
    return fail('too-many-files');
  }

  async getMod(modId: number): Promise<AddonSummary> {
    assertId(modId);
    const response = await this.request(`/mods/${modId}`, modResponseSchema);
    if (response.data.id !== modId) fail('invalid-response');
    return summary(response.data);
  }

  /** Reads the API's latest tagged files without scanning a project's full historical archive. */
  async getLatestCompatibleFiles(modId: number, gameVersionTypeId: number): Promise<AddonFile[]> {
    assertId(modId);
    const metadata = await this.getMetadata();
    if (!metadata.versionTypes.some((type) => type.id === gameVersionTypeId)) fail('incompatible-version');
    const response = await this.request(`/mods/${modId}`, latestFilesResponseSchema);
    if (response.data.id !== modId) fail('invalid-response');
    return response.data.latestFiles
      .filter((file) => file.modId === modId && file.isAvailable)
      .map(addonFile)
      .filter((file) => file.gameVersionTypeIds.includes(gameVersionTypeId))
      .sort((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate));
  }

  async getFile(modId: number, fileId: number): Promise<AddonFile> {
    assertId(modId);
    assertId(fileId);
    const response = await this.request(`/mods/${modId}/files/${fileId}`, fileResponseSchema);
    if (response.data.modId !== modId || response.data.id !== fileId || !response.data.isAvailable)
      fail('invalid-response');
    return addonFile(response.data);
  }

  /** Checks current author distribution policy and uses only the URL returned by CurseForge. */
  async getDownloadUrl(modId: number, fileId: number): Promise<string> {
    const file = await this.getFile(modId, fileId);
    return this.resolveDownloadUrl(file);
  }

  /** Refetches metadata and rechecks the selected flavor before returning bytes with valid size and SHA-1. */
  async download(file: AddonFile, expectedVersionTypeId?: number): Promise<Buffer> {
    const current = await this.getFile(file.modId, file.id);
    if (expectedVersionTypeId !== undefined && !current.gameVersionTypeIds.includes(expectedVersionTypeId))
      fail('incompatible-version');
    if (!current.sha1 || current.fileLength <= 0 || current.fileLength > maxDownloadBytes) fail('download-integrity');
    let url = downloadUrl(await this.resolveDownloadUrl(current));
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(120000)]);
    try {
      for (let redirect = 0; redirect <= 5; redirect++) {
        // CurseForge requires this header for CDN requests from July 16, 2026.
        // https://blog.curseforge.com/introducing-api-key-authentication-for-curseforge-file-downloads/
        const response = await fetch(url, { headers: { 'x-api-key': this.apiKey }, signal, redirect: 'manual' });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) fail('unsafe-download-url');
          url = downloadUrl(new URL(location, url).href);
          continue;
        }
        await this.assertStatus(response);
        const bytes = await readBytes(response, Math.min(current.fileLength, maxDownloadBytes));
        if (bytes.length !== current.fileLength || createHash('sha1').update(bytes).digest('hex') !== current.sha1)
          fail('download-integrity');
        return bytes;
      }
      return fail('too-many-redirects');
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      if (this.lifetime.signal.aborted) return fail('disposed');
      return fail(signal.aborted ? 'timeout' : 'request-failed');
    }
  }

  private async loadMetadata(): Promise<AddonMetadata> {
    const [categories, versionTypes] = await Promise.all([
      this.request('/categories?gameId=1&classId=1', categoriesResponseSchema),
      this.request('/games/1/version-types', versionTypesResponseSchema),
    ]);
    return {
      categories: categories.data
        .filter((category) => category.classId === 1 || category.id === 1)
        .map((category) => ({
          id: category.id,
          name: category.name,
          slug: category.slug,
          parentCategoryId: category.parentCategoryId,
        })),
      versionTypes: versionTypes.data.map((type) => ({
        id: type.id,
        name: type.name,
        slug: type.slug,
        group: versionGroup(type.name, type.slug),
      })),
    };
  }

  private async resolveDownloadUrl(file: AddonFile): Promise<string> {
    const mod = await this.getMod(file.modId);
    if (!mod.allowDistribution) fail('distribution-disabled');
    // A null file URL is an author restriction. Never construct a CDN URL from the filename.
    if (file.downloadUrl === null) fail('download-unavailable');
    const response = await this.request(`/mods/${file.modId}/files/${file.id}/download-url`, downloadResponseSchema);
    if (response.data === null) fail('download-unavailable');
    return downloadUrl(response.data).href;
  }

  private async assertStatus(response: Response) {
    if (response.ok) return;
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) fail('unauthorized');
    if (response.status === 429) fail('rate-limited');
    if (response.status === 404) fail('not-found');
    fail('request-failed');
  }

  private async request<T>(path: string, schema: BaseSchema<unknown, T, BaseIssue<unknown>>): Promise<T> {
    if (this.lifetime.signal.aborted) fail('disposed');
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000)]);
    try {
      const response = await fetch(`https://api.curseforge.com/v1${path}`, {
        headers: { Accept: 'application/json', 'x-api-key': this.apiKey },
        redirect: 'error',
        signal,
      });
      await this.assertStatus(response);
      const bytes = await readBytes(response, 8 * 1024 * 1024);
      let body: unknown;
      try {
        body = JSON.parse(bytes.toString('utf8'));
      } catch {
        return fail('invalid-response');
      }
      const result = v.safeParse(schema, body);
      if (!result.success) fail('invalid-response');
      return result.output;
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      if (this.lifetime.signal.aborted) return fail('disposed');
      return fail(signal.aborted ? 'timeout' : 'request-failed');
    }
  }
}
