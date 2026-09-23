#!/usr/bin/env node
// Valide registry.json selon le contrat décrit dans README.md.
// Exécuté en CI (job `test`), le status check requis par la protection de branche sur main.

const fs = require("fs");
const path = require("path");

const REGISTRY_PATH = path.join(__dirname, "..", "registry.json");
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const REPO_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/;
const CHANNELS = ["release", "beta", "alpha"];

const errors = [];

function fail(message) {
  errors.push(message);
}

function compareSemverDesc(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pb[i] !== pa[i]) return pb[i] - pa[i];
  }
  return 0;
}

let raw;
try {
  raw = fs.readFileSync(REGISTRY_PATH, "utf8");
} catch (err) {
  console.error(`Cannot read registry.json: ${err.message}`);
  process.exit(1);
}

let registry;
try {
  registry = JSON.parse(raw);
} catch (err) {
  console.error(`registry.json is not valid JSON: ${err.message}`);
  process.exit(1);
}

if (registry.schema_version !== 2) {
  fail(`schema_version must be 2, got ${JSON.stringify(registry.schema_version)}`);
}

if (typeof registry.name !== "string" || registry.name.trim() === "") {
  fail("name must be a non-empty string");
}

if (typeof registry.updated_at !== "string" || Number.isNaN(Date.parse(registry.updated_at))) {
  fail(`updated_at must be a valid ISO 8601 date string, got ${JSON.stringify(registry.updated_at)}`);
}

if (!Array.isArray(registry.bundles)) {
  fail("bundles must be an array");
} else {
  const seenSlugs = new Set();

  registry.bundles.forEach((bundle, index) => {
    const where = `bundles[${index}]${bundle && bundle.slug ? ` (${bundle.slug})` : ""}`;

    if (typeof bundle.slug !== "string" || !SLUG_RE.test(bundle.slug)) {
      fail(`${where}: slug must be lower-kebab-case, got ${JSON.stringify(bundle.slug)}`);
    } else if (seenSlugs.has(bundle.slug)) {
      fail(`${where}: duplicate slug`);
    } else {
      seenSlugs.add(bundle.slug);
    }

    if (typeof bundle.name !== "string" || bundle.name.trim() === "") {
      fail(`${where}: name must be a non-empty string`);
    }

    if (typeof bundle.description !== "string" || bundle.description.trim() === "") {
      fail(`${where}: description must be a non-empty string`);
    }

    if (typeof bundle.repository_url !== "string" || !REPO_URL_RE.test(bundle.repository_url)) {
      fail(`${where}: repository_url must look like https://github.com/{owner}/{repo}, got ${JSON.stringify(bundle.repository_url)}`);
    }

    if (typeof bundle.versions !== "object" || bundle.versions === null || Array.isArray(bundle.versions)) {
      fail(`${where}: versions must be an object with release/beta/alpha keys`);
    } else {
      const extraKeys = Object.keys(bundle.versions).filter((k) => !CHANNELS.includes(k));
      if (extraKeys.length > 0) {
        fail(`${where}: versions has unexpected keys: ${extraKeys.join(", ")}`);
      }

      let anyNonEmpty = false;
      for (const channel of CHANNELS) {
        const list = bundle.versions[channel];
        if (!Array.isArray(list)) {
          fail(`${where}: versions.${channel} must be an array`);
          continue;
        }
        if (list.length > 0) anyNonEmpty = true;

        list.forEach((version, vIndex) => {
          if (typeof version !== "string" || !SEMVER_RE.test(version)) {
            fail(`${where}: versions.${channel}[${vIndex}] must be a plain X.Y.Z string (no "v" prefix), got ${JSON.stringify(version)}`);
          }
        });

        const sorted = [...list].sort(compareSemverDesc);
        if (JSON.stringify(sorted) !== JSON.stringify(list)) {
          fail(`${where}: versions.${channel} must be sorted newest first`);
        }

        // alpha est le canal le plus permissif : tout ce qui est offert sur
        // release/beta doit s'y retrouver aussi (release ⊆ beta ⊆ alpha).
        if (channel !== "alpha" && Array.isArray(bundle.versions.alpha)) {
          const missing = list.filter((v) => !bundle.versions.alpha.includes(v));
          if (missing.length > 0) {
            fail(`${where}: versions.${channel} has versions missing from versions.alpha: ${missing.join(", ")}`);
          }
        }
      }

      if (!anyNonEmpty) {
        fail(`${where}: versions must have at least one non-empty channel`);
      }
    }
  });
}

if (errors.length > 0) {
  console.error(`registry.json failed validation (${errors.length} error(s)):`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}

console.log("registry.json is valid.");
