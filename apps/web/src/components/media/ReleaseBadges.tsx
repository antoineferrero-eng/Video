import type { ReleaseInfo } from '@lumiere/shared';
import { Badge } from '../ui/Badge';

/** Badges techniques d'une release : résolution, HDR, codecs, langues, source. */
export function ReleaseBadges({ release, compact = false }: { release: ReleaseInfo; compact?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {release.resolution && (
        <Badge tone={release.resolution === '2160p' ? 'violet' : 'brand'}>
          {release.resolution === '2160p' ? '4K' : release.resolution}
        </Badge>
      )}
      {release.hdr && <Badge tone="violet">{release.hdr}</Badge>}
      {release.languages.map((language) => (
        <Badge key={language} tone="info">
          {language}
        </Badge>
      ))}
      {!compact && release.source && <Badge>{release.source}</Badge>}
      {!compact && release.videoCodec && <Badge>{release.videoCodec}</Badge>}
      {!compact && release.audioCodec && <Badge>{release.audioCodec}</Badge>}
      {!compact && release.edition && <Badge tone="warning">{release.edition}</Badge>}
      {!compact && release.service && <Badge>{release.service}</Badge>}
    </div>
  );
}
