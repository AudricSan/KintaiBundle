#!/usr/bin/env node
// Resynchronise `versions` de registry.json (schema 2 : un objet {release, beta,
// alpha}) avec les GitHub Releases taguées du repository_url de chaque bundle.
// La source de vérité de ce qui est installable reste les releases du dépôt du
// bundle, jamais ce fichier — ce script ne fait que la refléter.
//
// Canal déterminé via target_commitish (la branche source de la release) et le
// flag prerelease, PAS en inspectant le tag — même règle que Kintai lui-même
// (GithubUpdateService/AppSettingsService::updateChannel(), voir docs/releasing.md
// dans le dépôt principal Kintai) :
//   - release : uniquement les releases publiées depuis `main`, non prerelease.
//   - beta    : les releases publiées depuis `main` ou `beta` (exclut `alpha`).
//   - alpha   : toutes les releases, canal le plus permissif.

const fs = require("fs");
const path = require("path");

const REGISTRY_PATH = path.join(__dirname, "..", "registry.json");
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const CHANNELS = ["release", "beta", "alpha"];

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

function matchesChannel(release, channel) {
  const branch = release.target_commitish || "";
  const isPrerelease = Boolean(release.prerelease);
  switch (channel) {
    case "alpha":
      return true;
    case "beta":
      return branch !== "alpha";
    default:
      return branch === "main" && !isPrerelease;
  }
}

async function fetchReleases({ owner, repo }) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "KintaiBundle-sync-versions",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const releases = [];
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
    const page_releases = await res.json();
    if (page_releases.length === 0) break;

    for (const release of page_releases) {
      if (release.draft) continue;
      if (TAG_RE.test(release.tag_name)) {
        releases.push(release);
      }
    }

    if (page_releases.length < 100) break;
    page++;
  }

  return releases;
}

/** @returns {{release: string[], beta: string[], alpha: string[]}} */
function versionsByChannel(releases) {
  const result = {};
  for (const channel of CHANNELS) {
    const tags = releases
      .filter((r) => matchesChannel(r, channel))
      .map((r) => r.tag_name);
    tags.sort(compareSemverDesc);
    result[channel] = tags.map((t) => t.slice(1));
  }
  return result;
}

async function main() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  let changed = false;

  for (const bundle of registry.bundles) {
    const repoInfo = parseRepo(bundle.repository_url);
    let releases;
    try {
      releases = await fetchReleases(repoInfo);
    } catch (err) {
      console.error(`Skipping ${bundle.slug}: ${err.message}`);
      continue;
    }

    if (releases.length === 0) {
      console.warn(
        `Warning: ${bundle.slug} (${bundle.repository_url}) has no tagged vX.Y.Z releases; keeping existing versions.`
      );
      continue;
    }

    const versions = versionsByChannel(releases);

    const before = JSON.stringify(bundle.versions);
    const after = JSON.stringify(versions);
    if (before !== after) {
      console.log(`${bundle.slug}: ${before} -> ${after}`);
      bundle.versions = versions;
      changed = true;
    }
  }

  if (changed) {
    registry.schema_version = 2;
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
