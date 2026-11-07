export type AddonGame = 'retail' | 'classic' | 'forever';

export interface AddonClientSettings {
  directory: string;
  gameVersionTypeId: number | null;
}

/** The renderer receives configuration status, never the saved API key. */
export interface AddonSettings {
  hasApiKey: boolean;
  clients: Record<AddonGame, AddonClientSettings>;
}

export interface AddonSettingsUpdate {
  apiKey?: string;
  clearApiKey?: boolean;
  clients: Record<AddonGame, AddonClientSettings>;
}

export interface AddonCategory {
  id: number;
  name: string;
  slug: string;
  parentCategoryId: number | null;
}

export interface AddonVersionType {
  id: number;
  name: string;
  slug: string;
  group: AddonGame | null;
}

export interface AddonMetadata {
  categories: AddonCategory[];
  versionTypes: AddonVersionType[];
}

/** Resolves an explicit branch or the only matching API branch. Ambiguous Classic branches require selection. */
export function resolveAddonVersionType(
  metadata: AddonMetadata | undefined,
  game: AddonGame,
  selectedId: number | null | undefined,
): AddonVersionType | undefined {
  const choices = metadata?.versionTypes.filter((type) => type.group === game);
  if (selectedId != null) return choices?.find((type) => type.id === selectedId);
  return choices?.length === 1 ? choices[0] : undefined;
}

export interface AddonSummary {
  id: number;
  name: string;
  summary: string;
  logoUrl: string | null;
  websiteUrl: string;
  downloadCount: number;
  dateModified: string;
  authors: string[];
  categories: number[];
  allowDistribution: boolean;
}

export interface AddonFile {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  fileLength: number;
  releaseType: number;
  fileDate: string;
  gameVersions: string[];
  gameVersionTypeIds: number[];
  downloadUrl: string | null;
  sha1?: string;
  dependencies: { modId: number; required: boolean }[];
}

export interface AddonSearchRequest {
  game: AddonGame;
  gameVersionTypeId: number;
  categoryId?: number;
  search: string;
  index: number;
  sort: 'popular' | 'updated' | 'downloads';
}

export interface AddonSearchResult {
  addons: AddonSummary[];
  index: number;
  pageSize: number;
  totalCount: number;
}

export interface InstalledAddon {
  game: AddonGame;
  clientDirectory: string;
  modId: number;
  fileId: number;
  name: string;
  version: string;
  gameVersionTypeId: number;
  folders: string[];
  installedAt: string;
  backupPath?: string;
}

export interface AddonInstallRequest {
  game: AddonGame;
  modId: number;
  fileId: number;
}

export type AddonResult<T> = { ok: true; data: T } | { ok: false; error: string };
