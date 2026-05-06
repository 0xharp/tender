/**
 * Filesystem-backed docs loader.
 *
 * Source of truth is `docs/*.md` in the repo root - the same files GitHub
 * renders + that contributors edit normally. The web app reads them at
 * request time (force-dynamic so doc edits show up without a rebuild during
 * dev) and renders them via react-markdown.
 *
 * Slug = file name without extension, lowercased. We restrict to a known
 * allowlist so a stray .md anywhere in the repo can't be served.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Public-facing slug → repo-relative path. Add new docs here only.
 *  Order in this object drives the order in the in-app sidebar + index. */
const DOCS_REGISTRY = {
  faq: {
    file: 'docs/faq.md',
    title: 'FAQ',
    eyebrow: 'Start here',
    description:
      'Common questions about tendr.bid - what it is, how to use it, what stays private, what happens if a buyer or provider walks away.',
  },
  'privacy-model': {
    file: 'docs/privacy-model.md',
    title: 'How privacy works',
    eyebrow: 'Reference',
    description:
      'What stays sealed, what becomes public, and when. The cryptography that makes "sealed from everyone, including the buyer" a guarantee instead of a promise.',
  },
  lifecycle: {
    file: 'docs/lifecycle.md',
    title: 'RFP lifecycle',
    eyebrow: 'Reference',
    description:
      'What happens at each stage of an RFP, who can do what, and what terminates a project. A walkthrough from "create" to "completed."',
  },
  'reputation-model': {
    file: 'docs/reputation-model.md',
    title: 'On-chain reputation',
    eyebrow: 'Reference',
    description:
      'What every BuyerReputation + ProviderReputation field counts, which actions update it, and the derived metrics the UI shows.',
  },
  identity: {
    file: 'docs/identity.md',
    title: 'Identity (SNS)',
    eyebrow: 'Reference',
    description:
      'How `.sol` names work in tendr.bid — and what this layer does NOT change about the privacy guarantees you get from the rest of the system.',
  },
  ai: {
    file: 'docs/ai.md',
    title: 'AI (QVAC)',
    eyebrow: 'Reference',
    description:
      'How the three AI buttons in the app work, where data flows when you use them, and what the privacy story is — without any third-party AI provider in the loop.',
  },
} as const;

export type DocSlug = keyof typeof DOCS_REGISTRY;

export const DOC_SLUGS = Object.keys(DOCS_REGISTRY) as DocSlug[];

export interface DocMeta {
  slug: DocSlug;
  title: string;
  eyebrow: string;
  description: string;
  /** Public GitHub URL for the source `.md` - shown as "edit on GitHub". */
  githubUrl: string;
}

const REPO_GITHUB = 'https://github.com/0xharp/tender';

export function listDocsMeta(): DocMeta[] {
  return DOC_SLUGS.map((slug) => docMeta(slug));
}

export function docMeta(slug: DocSlug): DocMeta {
  const entry = DOCS_REGISTRY[slug];
  return {
    slug,
    title: entry.title,
    eyebrow: entry.eyebrow,
    description: entry.description,
    githubUrl: `${REPO_GITHUB}/blob/main/${entry.file}`,
  };
}

export function isDocSlug(s: string): s is DocSlug {
  return s in DOCS_REGISTRY;
}

/** Read the raw markdown for a doc. Resolves the repo root relative to this
 *  file so it works in both `apps/web` dev runs and a built next server. */
export async function readDocMarkdown(slug: DocSlug): Promise<string> {
  const repoRoot = path.resolve(process.cwd(), '..', '..');
  const filePath = path.resolve(repoRoot, DOCS_REGISTRY[slug].file);
  return await fs.readFile(filePath, 'utf8');
}
