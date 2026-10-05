import { describe, it, expect } from 'vitest'
import {
  decodeSlugToPath,
  encodePathToSlug,
  slugFromSessionPath,
  resolveFolderPathBySlug
} from '../src/renderer/src/lib/folder-slug'

describe('decodeSlugToPath (lossy, kept as last-resort fallback)', () => {
  it('decodes a dash-free path correctly', () => {
    expect(decodeSlugToPath('-home-u-Workspace-sandbox-om2tab')).toBe(
      '/home/u/Workspace/sandbox/om2tab'
    )
  })

  it('is LOSSY for a path whose components contain literal dashes', () => {
    // This is the documented limitation: every `-` becomes `/`, so a real
    // folder named `TASK-1234-feature-alpha` decodes to a path that
    // does not exist on disk. The test pins the lossy behavior so callers know
    // they cannot rely on it for dash-folders.
    expect(decodeSlugToPath('-home-u-worktrees-TASK-1234-feature-alpha')).toBe(
      '/home/u/worktrees/TASK/1234/feature/alpha'
    )
  })

  it('returns null for a slug not starting with a separator', () => {
    expect(decodeSlugToPath('main')).toBeNull()
  })
})

describe('encodePathToSlug (faithful forward direction)', () => {
  // The rule was confirmed empirically against every real `~/.claude/projects/`
  // dir on the dev machine: every non-alphanumeric char maps to `-`, case is
  // preserved (`/`, `.`, `@`, space each observed; zero mismatches over 49 dirs).
  it('replaces path separators with dashes (dash-free path)', () => {
    expect(encodePathToSlug('/home/u/Workspace/sandbox/om2tab')).toBe(
      '-home-u-Workspace-sandbox-om2tab'
    )
  })

  it('encodes a dash-folder so literal dashes are indistinguishable from separators', () => {
    // The crux of lesson 003: the literal `-`s in the worktree name and the path
    // separators both become `-`, which is why the reverse decode is lossy but
    // the forward encode is exact.
    expect(encodePathToSlug('/home/u/worktrees/TASK-1234-feature-alpha')).toBe(
      '-home-u-worktrees-TASK-1234-feature-alpha'
    )
    expect(encodePathToSlug('/home/u/worktrees/TASK-0240-build-footer')).toBe(
      '-home-u-worktrees-TASK-0240-build-footer'
    )
  })

  it('replaces dots, spaces and @ with dashes (real-world examples)', () => {
    expect(encodePathToSlug('/home/u/Workspace/me/example.com.br/www')).toBe(
      '-home-u-Workspace-me-example-com-br-www'
    )
    expect(encodePathToSlug('/home/u/.claude/skills')).toBe('-home-u--claude-skills')
    expect(encodePathToSlug('/home/u/Google Drive/Claude')).toBe('-home-u-Google-Drive-Claude')
    expect(encodePathToSlug('/home/u/user@example.com/x')).toBe('-home-u-user-example-com-x')
  })

  it('replaces underscores too (rule is every non-alphanumeric char → dash)', () => {
    // No real underscore dir existed to pin empirically, but Claude's rule maps
    // ALL non-alphanumerics; this documents the contract.
    expect(encodePathToSlug('/home/u/my_project')).toBe('-home-u-my-project')
  })

  it('round-trips through slugFromSessionPath for a dash-folder JSONL', () => {
    const path = '/home/u/worktrees/TASK-0240-build-footer'
    const slug = encodePathToSlug(path)
    expect(slugFromSessionPath(`/home/u/.claude/projects/${slug}/sess-1.jsonl`)).toBe(slug)
  })
})

describe('slugFromSessionPath', () => {
  it("extracts the slug (parent dir) from a session's JSONL fullPath", () => {
    expect(
      slugFromSessionPath(
        '/home/u/.claude/projects/-home-u-worktrees-TASK-1234-feature-alpha/abc-123.jsonl'
      )
    ).toBe('-home-u-worktrees-TASK-1234-feature-alpha')
  })

  it('returns null for an empty fullPath (synthetic sessions)', () => {
    expect(slugFromSessionPath('')).toBeNull()
  })

  it('handles Windows-style separators', () => {
    expect(slugFromSessionPath('C:\\Users\\u\\.claude\\projects\\-c-proj\\abc.jsonl')).toBe(
      '-c-proj'
    )
  })
})

describe('resolveFolderPathBySlug', () => {
  it('LOSSLESSLY resolves a dash-folder via a real session fullPath, where decode would fail', () => {
    // Regression for the duplicated "New session" bug: the watcher emits the
    // slug; the folder is keyed by the JSONL `cwd`. For a dash-folder the lossy
    // decode produces a non-existent path, so reconciliation used to bail and
    // leave a synthetic alongside the real session (synced content, /clear hit
    // both). The lossless path keeps them collapsed.
    const slug = '-home-u-worktrees-TASK-1234-feature-alpha'
    const folders = [
      {
        path: '/home/u/worktrees/TASK-1234-feature-alpha',
        sessions: [
          {
            fullPath: `/home/u/.claude/projects/${slug}/sess-1.jsonl`
          }
        ]
      }
    ]
    expect(resolveFolderPathBySlug(slug, folders)).toBe('/home/u/worktrees/TASK-1234-feature-alpha')
  })

  it('resolves a dash-free folder with no real sessions yet via forward-encode', () => {
    const folders = [{ path: '/home/u/proj', sessions: [] }]
    expect(resolveFolderPathBySlug('-home-u-proj', folders)).toBe('/home/u/proj')
  })

  it('returns null when no folder owns the slug', () => {
    const folders = [
      {
        path: '/home/u/proj',
        sessions: [{ fullPath: '/home/u/.claude/projects/-home-u-proj/a.jsonl' }]
      }
    ]
    expect(resolveFolderPathBySlug('-home-u-other', folders)).toBeNull()
  })

  it('LOSSLESSLY resolves a dash-folder that only holds a synthetic (no fullPath) via forward-encode', () => {
    // Lesson 003 follow-up: the former "known limitation". A brand-new
    // dash-folder whose ONLY session is the synthetic placeholder (fullPath ===
    // '') has no real JSONL to resolve route 1, and the reverse decode is lossy —
    // but forward-encoding the folder's own path matches the slug exactly, so the
    // synthetic can migrate in place instead of duplicating.
    const slug = '-home-u-worktrees-TASK-1234-feature-alpha'
    const folders = [
      {
        path: '/home/u/worktrees/TASK-1234-feature-alpha',
        sessions: [{ fullPath: '' }]
      }
    ]
    expect(resolveFolderPathBySlug(slug, folders)).toBe('/home/u/worktrees/TASK-1234-feature-alpha')
  })
})
