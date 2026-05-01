# AI Patcher patches

Place one-off patch files here. Each patch is a JavaScript module that exports a function:

```js
export default async function patch({ dryRun, log, game, canvas, ui, foundry, CONST, createOrUpdateDocument }) {
  log("Doing work");

  if (dryRun) return { wouldChange: "..." };

  // Use Foundry document APIs here.
  return { changed: "..." };
}
```

Run a patch as a GM inside a world:

```text
/cwp run example-create-journal
/cwp run example-create-journal --dry-run
/aip run example-create-journal
/aip run example-create-journal --dry-run
```

The same API is available from a macro or browser console:

```js
await game.aiPatcher.runPatch("example-create-journal");
await game.aiPatcher.runPatch("example-create-journal", { dryRun: true });
```
