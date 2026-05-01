# AI Patcher

Local Foundry VTT module for applying small scripted world patches prepared outside Foundry.

## Installation

Install in Foundry using this manifest URL:

```text
https://raw.githubusercontent.com/LittleDespairs/AI-Patcher/main/module.json
```

## Workflow

1. Enable `AI Patcher` in a world.
2. Put a patch file in your Foundry user data folder under `Data/modules/ai-patcher/patches`.
3. As a GM, run it from chat:

```text
/aip run patch-file-name
```

Use `--dry-run` first when the patch supports it:

```text
/aip run patch-file-name --dry-run
```

Every run writes a journal entry to `AI Patch Log`.

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

The module only loads files from its own `patches` folder and only allows GM users to run them.
