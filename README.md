# AI Patcher

Local Foundry VTT module for applying small scripted world patches prepared outside Foundry.

## Installation

Install in Foundry using this manifest URL:

```text
https://raw.githubusercontent.com/LittleDespairs/AI-Patcher/main/module.json
```

## Workflow

1. Enable `AI Patcher` in a world.
2. Enable its dependency `Chat Commander` / `_chatcommands` if Foundry does not enable it automatically.
3. Ask an AI assistant or another tool to place a local bundle in `Data/modules/ai-patcher/inbox`.
4. In Foundry, click the `AI Patcher` scene-controls button, or run `/aip inbox`.
5. Click `Dry Run`, then `Apply`.

The local bundle files are not published to this repository. The repository only ships the module code that can read and run them.

The older direct patch workflow still works. Put a patch file in your Foundry user data folder under `Data/modules/ai-patcher/patches`, then run:

```text
/aip run patch-file-name
```

Use `--dry-run` first when the patch supports it:

```text
/aip run patch-file-name --dry-run
```

Every run writes a journal entry to `AI Patch Log`.

## Local Inbox Format

Create `Data/modules/ai-patcher/inbox/index.json`:

```json
{
  "bundles": [
    {
      "id": "example-work",
      "title": "Example Work",
      "description": "Creates a test journal entry.",
      "createdAt": "2026-05-01T18:00:00Z",
      "entry": "patch.js"
    }
  ]
}
```

Then create `Data/modules/ai-patcher/inbox/example-work/patch.js`:

```js
export default async function patch({ dryRun, log }) {
  log("Preparing example work");
  if (dryRun) return { wouldCreate: "JournalEntry" };

  const entry = await JournalEntry.create({ name: "Example Work" });
  return { created: entry.uuid };
}
```

## Patch contract

A patch must export a function as `default`, `apply`, or `patch`.

```js
export default async function patch({ dryRun, log, game, canvas, ui, foundry, CONST, createOrUpdateDocument }) {
  log("Patch started");

  if (dryRun) {
    return { wouldChange: "Describe intended changes" };
  }

  // Make Foundry document changes here.
  return { changed: "Describe completed changes" };
}
```

The module only loads files from its own `inbox` and `patches` folders and only allows GM users to run them.
