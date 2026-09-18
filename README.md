# KintaiBundle — Official Kintai bundle registry

🌐 **English** · [Français](#français)

This repository holds `registry.json`, the official list of installable [Kintai](https://github.com/AudricSan/Kintai) bundles — the same idea as a Home Assistant add-on repository. It's consumed as a raw static file (`raw.githubusercontent.com/AudricSan/KintaiBundle/main/registry.json`), never cloned: Kintai's `BundleRegistryClient` does a plain HTTP GET against it.

It's added by default on every Kintai instance and can't be removed from `/admin/bundles/registries` (an Owner can still add their own additional registries, official or third-party, alongside it).

## `registry.json` format

```json
{
    "schema_version": 1,
    "name": "Registry officiel Kintai",
    "updated_at": "2026-09-19T00:00:00Z",
    "bundles": [
        {
            "slug": "feedback",
            "name": "Retours utilisateurs",
            "description": "...",
            "repository_url": "https://github.com/AudricSan/kintai-bundle-feedback",
            "versions": ["1.0.0"]
        }
    ]
}
```

- `schema_version` must be `1` — a Kintai instance that doesn't understand a newer schema rejects the listing cleanly instead of misreading it.
- `repository_url` must be a GitHub repository (`https://github.com/{owner}/{repo}`) with tagged releases (`vX.Y.Z`) — Kintai downloads a specific version's zipball via the GitHub Releases API, never `git clone`/`pull`.
- `versions` lists every installable version, newest first; the bundle's own `bundle.json` (inside its repository, read at install time) is the actual source of truth for compatibility (`kintai_core.min`/`max`) and everything else.
- Each bundle's own repository is authoritative for its code and manifest — this file only points to it.

## Proposing a bundle

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow. In short: open a pull request adding an entry to `registry.json`. To be accepted, a bundle needs:
- A public repository with a `bundle.json` at its root (see [docs/creating-a-bundle.md](https://github.com/AudricSan/Kintai/blob/main/docs/creating-a-bundle.md) in the main Kintai repository for the full format and contract).
- At least one tagged GitHub Release matching a version in `bundle.json`.

Listing here doesn't imply Kintai-project maintenance — only bundles also listed in [`config/official-bundles.php`](https://github.com/AudricSan/Kintai/blob/main/config/official-bundles.php) are flagged "official" in the installer UI; everything else is clearly marked third-party, with an explicit confirmation required before install.

---

## Français

Ce dépôt contient `registry.json`, la liste officielle des bundles [Kintai](https://github.com/AudricSan/Kintai) installables — sur le même principe qu'un dépôt d'add-ons Home Assistant. Il est consommé comme un simple fichier statique en HTTP (`raw.githubusercontent.com/AudricSan/KintaiBundle/main/registry.json`), jamais cloné : `BundleRegistryClient` côté Kintai fait un simple GET dessus.

Il est ajouté par défaut sur toute instance Kintai et ne peut pas être supprimé depuis `/admin/bundles/registries` (un Owner peut toujours ajouter ses propres registries, officiels ou tiers, en plus de celui-ci).

### Format de `registry.json`

Voir l'exemple ci-dessus (section anglaise) — le format est identique quelle que soit la langue de ce README.

- `schema_version` doit valoir `1` — une instance Kintai qui ne comprend pas un schéma plus récent rejette proprement le listing au lieu de le mal interpréter.
- `repository_url` doit être un dépôt GitHub (`https://github.com/{owner}/{repo}`) avec des releases taguées (`vX.Y.Z`) — Kintai télécharge le zipball d'une version précise via l'API GitHub Releases, jamais `git clone`/`pull`.
- `versions` liste chaque version installable, la plus récente en premier ; le `bundle.json` propre au bundle (dans son dépôt, lu au moment de l'installation) reste la source de vérité pour la compatibilité (`kintai_core.min`/`max`) et tout le reste.
- Le dépôt propre à chaque bundle fait autorité sur son code et son manifeste — ce fichier ne fait que pointer vers lui.

### Proposer un bundle

Voir [CONTRIBUTING.md](CONTRIBUTING.md) (en anglais) pour le workflow complet. En résumé : ouvrez une pull request ajoutant une entrée à `registry.json`. Pour être accepté, un bundle doit avoir :
- Un dépôt public avec un `bundle.json` à sa racine (voir [docs/creating-a-bundle.md](https://github.com/AudricSan/Kintai/blob/main/docs/creating-a-bundle.md) dans le dépôt principal Kintai pour le format et le contrat complets).
- Au moins une release GitHub taguée correspondant à une version de `bundle.json`.

Être listé ici n'implique pas une maintenance par le projet Kintai — seuls les bundles également listés dans [`config/official-bundles.php`](https://github.com/AudricSan/Kintai/blob/main/config/official-bundles.php) sont marqués "officiel" dans l'interface d'installation ; tout le reste est clairement signalé comme tiers, avec une confirmation explicite exigée avant l'installation.
