import type { MediaAvailability, ReleaseInfo } from './catalog';

export type ExplorerEntryKind = 'directory' | 'video' | 'subtitle' | 'other';

export interface ExplorerEntry {
  name: string;
  path: string;
  kind: ExplorerEntryKind;
  size: number | null;
  modifiedAt: string | null;
  release: ReleaseInfo | null;
  availability: MediaAvailability | null;
}

export interface ExplorerListing {
  path: string;
  parent: string | null;
  breadcrumbs: Array<{ name: string; path: string }>;
  entries: ExplorerEntry[];
  sourceUrl: string;
  format: string;
}
