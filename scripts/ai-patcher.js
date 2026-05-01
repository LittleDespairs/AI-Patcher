const MODULE_ID = "ai-patcher";
const PATCH_ROOT = `modules/${MODULE_ID}/patches`;
const INBOX_ROOT = `modules/${MODULE_ID}/inbox`;

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

function normalizeBundlePart(value, label = "path") {
  const text = String(value ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!text) throw new Error(`${label} is required.`);
  if (text.includes("..")) throw new Error(`${label} cannot contain parent directory segments.`);
  if (!/^[a-zA-Z0-9/_.,-]+$/.test(text)) throw new Error(`${label} contains unsupported characters.`);
  return text;
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

async function loadInboxIndex() {
  requireGM();

  const response = await fetch(routeFor(`${INBOX_ROOT}/index.json?v=${Date.now()}`), { cache: "no-store" });
  if (response.status === 404) return { bundles: [] };
  if (!response.ok) throw new Error(`Unable to load AI Patcher inbox index: HTTP ${response.status}`);

  const index = await response.json();
  const bundles = Array.isArray(index.bundles) ? index.bundles : [];
  return { ...index, bundles };
}

async function runBundle(id, options = {}) {
  requireGM();

  const bundleId = normalizeBundlePart(id, "Bundle id");
  const index = await loadInboxIndex();
  const bundle = index.bundles.find((entry) => entry.id === bundleId);
  if (!bundle) throw new Error(`AI Patcher bundle not found: ${bundleId}`);

  const entry = normalizeBundlePart(bundle.entry ?? "patch.js", "Bundle entry");
  if (!entry.endsWith(".js") && !entry.endsWith(".mjs")) throw new Error("Bundle entry must be a JavaScript module.");

  return runPatchModule(`${INBOX_ROOT}/${bundleId}/${entry}`, {
    ...options,
    patchName: bundle.title || bundleId,
    bundle
  });
}

async function runPatch(name, options = {}) {
  requireGM();

  const patchName = normalizePatchName(name);
  return runPatchModule(`${PATCH_ROOT}/${patchName}`, { ...options, patchName });
}

async function runPatchModule(modulePath, options = {}) {
  requireGM();

  const patchName = String(options.patchName ?? modulePath);
  const dryRun = Boolean(options.dryRun);
  const notify = options.notify !== false;
  const journal = options.journal !== false;
  const url = routeFor(`${modulePath}?v=${Date.now()}`);
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
      bundle: options.bundle,
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

function parseParameters(parameters) {
  const parts = parameters.trim().split(/\s+/).filter(Boolean);
  const command = parts[0] ?? "help";
  const patchName = parts[1];
  const dryRun = parts.includes("--dry-run") || parts.includes("-n");
  return { command, patchName, dryRun };
}

async function showHelp() {
  const content = `<p><strong>AI Patcher</strong></p>
<ul>
  <li><code>/aip inbox</code> - open the local bundle inbox</li>
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

function bundleListContent(index) {
  const bundles = index.bundles ?? [];
  if (!bundles.length) {
    return `<div class="ai-patcher-inbox">
      <p>${localize("inbox.empty")}</p>
      <p><code>Data/modules/ai-patcher/inbox/index.json</code></p>
    </div>`;
  }

  const rows = bundles.map((bundle) => {
    const id = escapeHTML(bundle.id);
    const title = escapeHTML(bundle.title || bundle.id);
    const description = escapeHTML(bundle.description || "");
    const createdAt = escapeHTML(bundle.createdAt || "");
    return `<article class="ai-patcher-bundle" data-bundle-id="${id}">
      <header>
        <h3>${title}</h3>
        ${createdAt ? `<span>${createdAt}</span>` : ""}
      </header>
      ${description ? `<p>${description}</p>` : ""}
      <footer>
        <button type="button" data-action="dry-run" data-bundle-id="${id}">
          <i class="fas fa-vial"></i> ${localize("inbox.dryRun")}
        </button>
        <button type="button" data-action="apply" data-bundle-id="${id}">
          <i class="fas fa-check"></i> ${localize("inbox.apply")}
        </button>
      </footer>
    </article>`;
  }).join("");

  return `<div class="ai-patcher-inbox">${rows}</div>`;
}

async function openInbox() {
  requireGM();

  let index;
  try {
    index = await loadInboxIndex();
  } catch (error) {
    ui.notifications.error(formatError(error));
    throw error;
  }

  const dialog = new Dialog({
    title: localize("inbox.title"),
    content: bundleListContent(index),
    buttons: {
      refresh: {
        icon: '<i class="fas fa-rotate"></i>',
        label: localize("inbox.refresh"),
        callback: () => openInbox()
      },
      close: {
        icon: '<i class="fas fa-times"></i>',
        label: localize("inbox.close")
      }
    },
    render: (html) => {
      html.find("button[data-action]").on("click", async (event) => {
        const button = event.currentTarget;
        const bundleId = button.dataset.bundleId;
        const dryRun = button.dataset.action === "dry-run";
        button.disabled = true;

        try {
          await runBundle(bundleId, { dryRun });
          if (!dryRun) dialog.close();
        } catch (error) {
          console.error(`${MODULE_ID} | ${formatError(error)}`);
        } finally {
          button.disabled = false;
        }
      });
    }
  });

  dialog.render(true);
  return dialog;
}

function handleParsedCommand(parsed) {
  if (!game.user?.isGM) {
    ui.notifications.warn(localize("errors.gmOnly"));
    return;
  }

  if (parsed.command === "inbox" || parsed.command === "open") {
    openInbox();
    return;
  }

  if (parsed.command === "help" || !parsed.patchName) {
    showHelp();
    return;
  }

  if (parsed.command !== "run") {
    ui.notifications.warn(localize("errors.unknownCommand"));
    showHelp();
    return;
  }

  runPatch(parsed.patchName, { dryRun: parsed.dryRun })
    .then(() => game.settings.set(MODULE_ID, "lastPatch", parsed.patchName))
    .catch((error) => console.error(`${MODULE_ID} | ${formatError(error)}`));
}

function registerChatCommand() {
  if (!game.chatCommands) return false;
  if (game.chatCommands.commands?.has("/aip")) return true;

  game.chatCommands.register({
    name: "/aip",
    aliases: ["/ai-patch", "/cwp", "/codex-patch"],
    module: MODULE_ID,
    requiredRole: "GAMEMASTER",
    icon: "<i class='fas fa-wand-magic-sparkles'></i>",
    description: "Run AI Patcher world patches.",
    callback: (_chat, parameters) => {
      handleParsedCommand(parseParameters(parameters));
      return {};
    }
  });

  return true;
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
    openInbox,
    loadInboxIndex,
    runBundle,
    runPatch,
    normalizePatchName,
    createOrUpdateDocument
  };
  game.codexWorldPatcher = game.aiPatcher;

  registerChatCommand();
  console.log(`${MODULE_ID} | Ready. Use /aip run patch-name or game.aiPatcher.runPatch("patch-name").`);
});

Hooks.on("chatCommandsReady", () => {
  registerChatCommand();
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;

  const tool = {
    name: "ai-patcher-inbox",
    title: localize("inbox.title"),
    icon: "fas fa-wand-magic-sparkles",
    button: true,
    visible: true,
    order: 10,
    onClick: openInbox,
    onChange: openInbox
  };

  if (Array.isArray(controls)) {
    controls.push({
      name: "ai-patcher",
      title: "AI Patcher",
      icon: "fas fa-wand-magic-sparkles",
      tools: [tool],
      activeTool: "ai-patcher-inbox"
    });
    return;
  }

  controls["ai-patcher"] = {
    name: "ai-patcher",
    title: "AI Patcher",
    icon: "fas fa-wand-magic-sparkles",
    order: 1000,
    tools: {
      inbox: tool
    },
    activeTool: "inbox"
  };
});

Hooks.on("chatMessage", (_chatLog, messageText) => {
  const parsed = parseCommand(messageText);
  if (!parsed) return true;

  handleParsedCommand(parsed);
  return false;
});
