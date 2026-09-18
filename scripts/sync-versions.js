#!/usr/bin/env node
// Resynchronise les tableaux `versions` de registry.json avec les GitHub Releases
// taguées du repository_url de chaque bundle. La source de vérité de ce qui est
// installable reste les releases du dépôt du bundle, jamais ce fichier — ce
// script ne fait que la refléter.

const fs = require("fs");
const path = require("path");

const REGISTRY_PATH = path.join(__dirname, "..", "registry.json");
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

function parseRepo(repositoryUrl) {
  const match = repositoryUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/
  );
  if (!match) {
    throw new Error(`repository_url is not a GitHub repo URL: ${repositoryUrl}`);
  }
  return { owner: match[1], repo: match[2] };
}

function compareSemverDesc(a, b) {
  const pa = a.match(TAG_RE);
  const pb = b.match(TAG_RE);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pb[i]) - Number(pa[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchReleaseVersions({ owner, repo }) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "KintaiBundle-sync-versions",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const versions = [];
  let page = 1;
  for (;;) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100&page=${page}`,
      { headers }
    );
    if (res.status === 404) {
      // Le dépôt n'a pas encore de releases, ou n'existe pas (ex : bundle proposé mais pas encore publié).
      break;
    }
    if (!res.ok) {
      throw new Error(
        `GitHub API error for ${owner}/${repo}: ${res.status} ${res.statusText}`
      );
    }
    const releases = await res.json();
    if (releases.length === 0) break;

    for (const release of releases) {
      if (release.draft) continue;
      if (release.prerelease) continue;
      if (TAG_RE.test(release.tag_name)) {
        versions.push(release.tag_name.slice(1));
      }
    }

    if (releases.length < 100) break;
    page++;
  }

  versions.sort((a, b) => compareSemverDesc(`v${a}`, `v${b}`));
  return versions;
}

async function main() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  let changed = false;

  for (const bundle of registry.bundles) {
    const repoInfo = parseRepo(bundle.repository_url);
    let versions;
    try {
      versions = await fetchReleaseVersions(repoInfo);
    } catch (err) {
      console.error(`Skipping ${bundle.slug}: ${err.message}`);
      continue;
    }

    if (versions.length === 0) {
      console.warn(
        `Warning: ${bundle.slug} (${bundle.repository_url}) has no tagged vX.Y.Z releases; keeping existing versions.`
      );
      continue;
    }

    const before = JSON.stringify(bundle.versions);
    const after = JSON.stringify(versions);
    if (before !== after) {
      console.log(`${bundle.slug}: ${before} -> ${after}`);
      bundle.versions = versions;
      changed = true;
    }
  }

  if (changed) {
    registry.updated_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 4) + "\n");
    console.log("registry.json updated.");
  } else {
    console.log("No version changes detected.");
  }

  // Indique au workflow si une PR est nécessaire.
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
