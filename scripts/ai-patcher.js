const MODULE_ID = "ai-patcher";
const PATCH_ROOT = `modules/${MODULE_ID}/patches`;

function localize(key) {
  return game.i18n.localize(`${MODULE_ID}.${key}`);
}

function routeFor(path) {
  if (foundry.utils.getRoute) return foundry.utils.getRoute(path);
  return `/${path}`;
}

function requireGM() {
  if (game.user?.isGM) return;
  throw new Error(localize("errors.gmOnly"));
}

function normalizePatchName(name) {
  const rawName = String(name ?? "").trim();
  if (!rawName) throw new Error(localize("errors.patchRequired"));

  const cleanName = rawName
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^patches\//, "");

  if (cleanName.includes("..")) throw new Error(localize("errors.badPath"));
  if (!/^[a-zA-Z0-9/_-]+(\.m?js)?$/.test(cleanName)) throw new Error(localize("errors.badName"));

  return cleanName.endsWith(".js") || cleanName.endsWith(".mjs") ? cleanName : `${cleanName}.js`;
}

function formatError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function escapeHTML(value) {
  const text = String(value ?? "");
  if (foundry.utils.escapeHTML) return foundry.utils.escapeHTML(text);
  return text.replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[character];
  });
}

async function postRunSummary({ patchName, dryRun, result, error }) {
  const folderName = localize("journal.folder");
  let folder = game.folders.find((entry) => entry.type === "JournalEntry" && entry.name === folderName);
  if (!folder) folder = await Folder.create({ name: folderName, type: "JournalEntry" });

  const timestamp = new Date().toLocaleString();
  const status = error ? localize("journal.failed") : localize("journal.completed");
  const title = `${status}: ${patchName}`;
  const body = error
    ? `<p><strong>${localize("journal.error")}</strong></p><pre>${escapeHTML(formatError(error))}</pre>`
    : `<p><strong>${localize("journal.result")}</strong></p><pre>${escapeHTML(JSON.stringify(result ?? {}, null, 2))}</pre>`;

  return JournalEntry.create({
    name: title,
    folder: folder.id,
    pages: [
      {
        name: localize("journal.page"),
        type: "text",
        text: {
          format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML,
          content: `<p><strong>${localize("journal.patch")}</strong> ${escapeHTML(patchName)}</p>
<p><strong>${localize("journal.when")}</strong> ${escapeHTML(timestamp)}</p>
<p><strong>${localize("journal.dryRun")}</strong> ${dryRun ? localize("yes") : localize("no")}</p>
${body}`
        }
      }
    ]
  });
}

async function createOrUpdateDocument(collection, match, data, { dryRun = false } = {}) {
  const existing = collection.find((document) => {
    return Object.entries(match).every(([key, value]) => foundry.utils.getProperty(document, key) === value);
  });

  if (dryRun) {
    return {
      action: existing ? "update" : "create",
      type: collection.documentName,
      match,
      data
    };
  }

  if (existing) return existing.update(data);
  return collection.documentClass.create({ ...match, ...data });
}

async function runPatch(name, options = {}) {
  requireGM();

  const patchName = normalizePatchName(name);
  const dryRun = Boolean(options.dryRun);
  const notify = options.notify !== false;
  const journal = options.journal !== false;
  const url = routeFor(`${PATCH_ROOT}/${patchName}?v=${Date.now()}`);
  const messages = [];

  const log = (...parts) => {
    const message = parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");
    messages.push(message);
    console.log(`${MODULE_ID} | ${message}`);
  };

  let result;
  try {
    log(`Loading ${patchName}`);
    const imported = await import(url);
    const patch = imported.default ?? imported.apply ?? imported.patch;
    if (typeof patch !== "function") throw new Error(localize("errors.noEntrypoint"));

    result = await patch({
      dryRun,
      log,
      game,
      canvas,
      ui,
      foundry,
      CONST,
      createOrUpdateDocument: (collection, match, data) =>
        createOrUpdateDocument(collection, match, data, { dryRun })
    });

    const payload = { ok: true, patchName, dryRun, result, messages };
    if (journal) await postRunSummary(payload);
    if (notify) ui.notifications.info(game.i18n.format(`${MODULE_ID}.notifications.done`, { patchName }));
    return payload;
  } catch (error) {
    const payload = { ok: false, patchName, dryRun, error, messages };
    console.error(`${MODULE_ID} | Patch failed`, error);
    if (journal) await postRunSummary(payload);
    if (notify) ui.notifications.error(game.i18n.format(`${MODULE_ID}.notifications.failed`, { patchName }));
    throw error;
  }
}

function parseCommand(messageText) {
  const parts = messageText.trim().split(/\s+/);
  if (parts[0] !== "/aip" && parts[0] !== "/ai-patch" && parts[0] !== "/cwp" && parts[0] !== "/codex-patch") return null;

  const command = parts[1] ?? "help";
  const patchName = parts[2];
  const dryRun = parts.includes("--dry-run") || parts.includes("-n");
  return { command, patchName, dryRun };
}

async function showHelp() {
  const content = `<p><strong>AI Patcher</strong></p>
<ul>
  <li><code>/aip run patch-name</code> - run <code>patches/patch-name.js</code></li>
  <li><code>/aip run patch-name --dry-run</code> - load the patch without writing changes</li>
  <li><code>await game.aiPatcher.runPatch("patch-name")</code> - console or macro API</li>
</ul>`;

  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: "AI Patcher" }),
    content,
    whisper: [game.user.id]
  });
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "lastPatch", {
    name: `${MODULE_ID}.settings.lastPatch.name`,
    hint: `${MODULE_ID}.settings.lastPatch.hint`,
    scope: "world",
    config: false,
    type: String,
    default: ""
  });
});

Hooks.once("ready", () => {
  game.aiPatcher = {
    runPatch,
    normalizePatchName,
    createOrUpdateDocument
  };
  game.codexWorldPatcher = game.aiPatcher;

  console.log(`${MODULE_ID} | Ready. Use /aip run patch-name or game.aiPatcher.runPatch("patch-name").`);
});

Hooks.on("chatMessage", (_chatLog, messageText) => {
  const parsed = parseCommand(messageText);
  if (!parsed) return true;

  if (!game.user?.isGM) {
    ui.notifications.warn(localize("errors.gmOnly"));
    return false;
  }

  if (parsed.command === "help" || !parsed.patchName) {
    showHelp();
    return false;
  }

  if (parsed.command !== "run") {
    ui.notifications.warn(localize("errors.unknownCommand"));
    showHelp();
    return false;
  }

  runPatch(parsed.patchName, { dryRun: parsed.dryRun })
    .then(() => game.settings.set(MODULE_ID, "lastPatch", parsed.patchName))
    .catch((error) => console.error(`${MODULE_ID} | ${formatError(error)}`));

  return false;
});
