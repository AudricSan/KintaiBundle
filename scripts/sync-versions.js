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
//
// Épinglage des commits (champ `commits` de chaque bundle : { "1.1.4": "<sha du commit du tag>" }) :
// Kintai compare le ZIP qu'il télécharge à ce commit avant de l'installer. Le registry devient ainsi le
// point de confiance (ses changements passent par une PR relue), et non plus « ce vers quoi pointe un tag
// au moment de l'installation » — un tag déplacé vers un commit piégé serait refusé.
// Règle essentielle : une empreinte est posée UNE fois puis n'est JAMAIS modifiée automatiquement. Si un
// tag déjà épinglé pointe désormais vers un autre commit, le script échoue bruyamment (job en erreur,
// aucune PR) au lieu de « corriger » l'empreinte, ce qui annulerait toute la protection.

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

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "KintaiBundle-sync-versions",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

const COMMIT_RE = /^[0-9a-f]{40}$/;

/**
 * Commit vers lequel pointe chaque tag vX.Y.Z du dépôt, sous forme { "vX.Y.Z": "<sha 40 hex>" }.
 * Un tag « léger » pointe directement sur un commit ; un tag « annoté » pointe sur un objet tag qu'il
 * faut déréférencer pour atteindre le commit.
 */
async function fetchTagCommits({ owner, repo }) {
  const headers = githubHeaders();
  const refs = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/matching-refs/tags/v?per_page=100&page=${page}`,
      { headers }
    );
    if (res.status === 404) break;
    if (!res.ok) {
      throw new Error(`GitHub API error (tags) for ${owner}/${repo}: ${res.status} ${res.statusText}`);
    }
    const batch = await res.json();
    refs.push(...batch);
    if (batch.length < 100) break;
  }

  const commits = {};
  for (const ref of refs) {
    const tag = ref.ref.replace(/^refs\/tags\//, "");
    if (!TAG_RE.test(tag)) continue;

    let object = ref.object;
    // Tag annoté : on suit la chaîne jusqu'au commit (quelques niveaux au plus en pratique).
    for (let depth = 0; object.type === "tag" && depth < 3; depth++) {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/tags/${object.sha}`,
        { headers }
      );
      if (!res.ok) {
        throw new Error(`GitHub API error (annotated tag ${tag}) for ${owner}/${repo}: ${res.status} ${res.statusText}`);
      }
      object = (await res.json()).object;
    }
    if (object.type === "commit" && COMMIT_RE.test(object.sha)) {
      commits[tag] = object.sha;
    }
  }
  return commits;
}

/**
 * Croise les releases avec le commit de leur tag et les empreintes déjà épinglées.
 * @returns {{commits: Object<string,string>, conflicts: Array, unpinnable: string[], releases: Array}}
 *   - commits : version -> sha à écrire (une empreinte existante est toujours conservée) ;
 *   - conflicts : versions déjà épinglées dont le tag pointe maintenant ailleurs ;
 *   - unpinnable : versions dont le tag est introuvable (jamais listées sans empreinte) ;
 *   - releases : les releases qui restent listables.
 */
function pinCommits(releases, tagCommits, existing) {
  const pinned = existing && typeof existing === "object" ? existing : {};
  const commits = {};
  const conflicts = [];
  const unpinnable = [];
  const listable = [];

  for (const release of releases) {
    const version = release.tag_name.slice(1);
    const actual = tagCommits[release.tag_name];
    const previous = pinned[version];

    if (previous && actual && previous !== actual) {
      conflicts.push({ version, pinned: previous, actual });
      commits[version] = previous; // on ne touche jamais à une empreinte existante
      listable.push(release);
    } else if (previous || actual) {
      commits[version] = previous || actual;
      listable.push(release);
    } else {
      unpinnable.push(version);
    }
  }
  return { commits, conflicts, unpinnable, releases: listable };
}

async function fetchReleases({ owner, repo }) {
  const headers = githubHeaders();

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

/** Empreintes triées par version décroissante, pour des diffs stables. */
function sortedCommits(commits) {
  const out = {};
  for (const version of Object.keys(commits).sort((a, b) => compareSemverDesc(`v${a}`, `v${b}`))) {
    out[version] = commits[version];
  }
  return out;
}

async function main() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  let changed = false;
  const conflicts = [];

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

    let tagCommits;
    try {
      tagCommits = await fetchTagCommits(repoInfo);
    } catch (err) {
      console.error(`Skipping ${bundle.slug}: ${err.message}`);
      continue;
    }

    const pinned = pinCommits(releases, tagCommits, bundle.commits);
    for (const version of pinned.unpinnable) {
      console.warn(
        `Warning: ${bundle.slug} ${version} has a release but its tag cannot be resolved to a commit; not listed.`
      );
    }
    for (const c of pinned.conflicts) {
      conflicts.push({ slug: bundle.slug, ...c });
    }

    const versions = versionsByChannel(pinned.releases);
    const commits = sortedCommits(pinned.commits);

    const before = JSON.stringify([bundle.versions, bundle.commits]);
    const after = JSON.stringify([versions, commits]);
    if (before !== after) {
      console.log(`${bundle.slug}: ${JSON.stringify(bundle.versions)} -> ${JSON.stringify(versions)}`);
      bundle.versions = versions;
      bundle.commits = commits;
      changed = true;
    }
  }

  if (conflicts.length > 0) {
    // Un tag épinglé a bougé : possible compromission d'un dépôt de bundle (ou re-tag légitime, à
    // trancher à la main). On échoue AVANT d'écrire quoi que ce soit : pas de PR automatique.
    for (const c of conflicts) {
      console.error(
        `::error::${c.slug} ${c.version}: le tag pointe maintenant vers ${c.actual} alors que le registry épingle ${c.pinned}. ` +
          "Le tag a été déplacé : vérifier le dépôt du bundle avant toute modification de registry.json."
      );
    }
    console.error(`${conflicts.length} tag(s) épinglé(s) ont changé de commit ; registry.json n'a pas été modifié.`);
    process.exit(1);
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

module.exports = { pinCommits, sortedCommits, versionsByChannel, matchesChannel, fetchTagCommits };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
