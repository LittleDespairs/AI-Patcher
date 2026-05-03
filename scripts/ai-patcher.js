const MODULE_ID = "ai-patcher";
const PATCH_ROOT = `modules/${MODULE_ID}/patches`;
const INBOX_ROOT = `modules/${MODULE_ID}/inbox`;
const AIPACK_SCHEMA = "ai-patcher.aipack.v1";
const DEFAULT_FEED_URL = "https://raw.githubusercontent.com/LittleDespairs/AI-Patcher-Catalog/main/index.json";
let lastFeedStatus = {
  ok: false,
  url: DEFAULT_FEED_URL,
  count: 0,
  error: ""
};

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

function normalizeBundleId(value) {
  const id = normalizeBundlePart(value, "Bundle id");
  if (id.includes("/")) throw new Error("Bundle id cannot contain slashes.");
  return id;
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

  let localBundles = [];
  const response = await fetch(routeFor(`${INBOX_ROOT}/index.json?v=${Date.now()}`), { cache: "no-store" });
  if (response.status !== 404) {
    if (!response.ok) throw new Error(`Unable to load AI Patcher inbox index: HTTP ${response.status}`);

    const index = await response.json();
    localBundles = Array.isArray(index.bundles) ? index.bundles : [];
  }

  const importedBundles = Object.values(game.settings.get(MODULE_ID, "importedBundles") ?? {});
  const remoteBundles = await loadRemoteBundles();
  return {
    feed: foundry.utils.deepClone(lastFeedStatus),
    bundles: [
      ...localBundles.map((bundle) => ({ ...bundle, source: bundle.source ?? "local" })),
      ...importedBundles.map((bundle) => ({ ...bundle, source: "imported" })),
      ...remoteBundles.filter((remoteBundle) => {
        return !importedBundles.some((importedBundle) => importedBundle.id === remoteBundle.id);
      })
    ]
  };
}

async function loadRemoteBundles() {
  const configuredUrl = String(game.settings.get(MODULE_ID, "feedUrl") || "").trim();
  const feedUrls = [configuredUrl || DEFAULT_FEED_URL];
  if (feedUrls[0] !== DEFAULT_FEED_URL) feedUrls.push(DEFAULT_FEED_URL);

  const merged = new Map();
  const statuses = [];

  for (const feedUrl of feedUrls) {
    try {
      const response = await fetch(`${feedUrl}${feedUrl.includes("?") ? "&" : "?"}v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const feed = await response.json();
      const bundles = Array.isArray(feed.bundles) ? feed.bundles : [];
      const remoteBundles = bundles.map((bundle) => ({
        id: normalizeBundleId(bundle.id),
        title: String(bundle.title || bundle.id),
        description: String(bundle.description || ""),
        createdAt: String(bundle.createdAt || ""),
        packageUrl: String(bundle.packageUrl || ""),
        source: "remote"
      })).filter((bundle) => bundle.packageUrl);

      for (const bundle of remoteBundles) {
        if (!merged.has(bundle.id)) merged.set(bundle.id, bundle);
      }
      statuses.push({ ok: true, url: feedUrl, count: remoteBundles.length, error: "" });
    } catch (error) {
      statuses.push({ ok: false, url: feedUrl, count: 0, error: formatError(error) });
      console.warn(`${MODULE_ID} | Unable to load remote feed`, feedUrl, error);
    }
  }

  const failures = statuses.filter((status) => !status.ok);
  const successes = statuses.filter((status) => status.ok);
  if (!successes.length && failures.length) ui.notifications.warn(localize("notifications.feedFailed"));

  lastFeedStatus = {
    ok: successes.length > 0,
    url: feedUrls.join(" + "),
    count: merged.size,
    error: failures.map((failure) => `${failure.url}: ${failure.error}`).join("\n")
  };

  return Array.from(merged.values());
}

async function runBundle(id, options = {}) {
  requireGM();

  const bundleId = normalizeBundleId(id);
  const index = await loadInboxIndex();
  const bundle = index.bundles.find((entry) => entry.id === bundleId);
  if (!bundle) throw new Error(`AI Patcher bundle not found: ${bundleId}`);

  if (bundle.source === "remote") {
    const importedBundle = await importAipackUrl(bundle.packageUrl);
    return runPatchSource(importedBundle.patchSource, {
      ...options,
      patchName: importedBundle.title || bundleId,
      bundle: importedBundle
    });
  }

  if (bundle.source === "imported") {
    return runPatchSource(bundle.patchSource, {
      ...options,
      patchName: bundle.title || bundleId,
      bundle
    });
  }

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

async function runPatchSource(source, options = {}) {
  requireGM();

  if (!source || typeof source !== "string") throw new Error("Imported bundle has no JavaScript patch source.");

  const patchName = String(options.patchName ?? "imported bundle");
  const dryRun = Boolean(options.dryRun);
  const notify = options.notify !== false;
  const journal = options.journal !== false;
  const messages = [];
  let objectUrl;

  const log = (...parts) => {
    const message = parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");
    messages.push(message);
    console.log(`${MODULE_ID} | ${message}`);
  };

  try {
    log(`Loading imported bundle ${patchName}`);
    objectUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const imported = await import(objectUrl);
    const patch = imported.default ?? imported.apply ?? imported.patch;
    if (typeof patch !== "function") throw new Error(localize("errors.noEntrypoint"));

    const result = await patch({
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
    console.error(`${MODULE_ID} | Imported patch failed`, error);
    if (journal) await postRunSummary(payload);
    if (notify) ui.notifications.error(game.i18n.format(`${MODULE_ID}.notifications.failed`, { patchName }));
    throw error;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function decodeBase64(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function ensureDataDirectory(path) {
  const parts = path.split("/").filter(Boolean);
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await FilePicker.createDirectory("data", current, {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!message.toLowerCase().includes("exist")) throw error;
    }
  }
}

async function uploadAipackAssets(bundleId, assets = []) {
  const assetMap = {};
  if (!Array.isArray(assets) || !assets.length) return assetMap;

  const root = `worlds/${game.world.id}/${MODULE_ID}/${bundleId}`;
  await ensureDataDirectory(root);

  for (const asset of assets) {
    const assetPath = normalizeBundlePart(asset.path, "Asset path");
    const segments = assetPath.split("/");
    const fileName = segments.pop();
    const directory = segments.length ? `${root}/${segments.join("/")}` : root;
    if (directory !== root) await ensureDataDirectory(directory);

    const bytes = decodeBase64(asset.data ?? "");
    const file = new File([bytes], fileName, { type: asset.mimeType || "application/octet-stream" });
    await FilePicker.upload("data", directory, file, { notify: false });
    assetMap[assetPath] = `${directory}/${fileName}`;
  }

  return assetMap;
}

function validateAipack(raw) {
  const packageData = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (packageData.schema !== AIPACK_SCHEMA) throw new Error(localize("errors.badPackage"));

  const bundle = packageData.bundle ?? {};
  const id = normalizeBundleId(bundle.id);
  const patchSource = String(packageData.patch ?? "");
  if (!patchSource.trim()) throw new Error(localize("errors.emptyPackagePatch"));

  return {
    bundle: {
      id,
      title: String(bundle.title || id),
      description: String(bundle.description || ""),
      createdAt: String(bundle.createdAt || new Date().toISOString()),
      entry: "patch.js"
    },
    patchSource,
    assets: Array.isArray(packageData.assets) ? packageData.assets : []
  };
}

async function importAipackFile(file) {
  requireGM();

  const raw = await file.text();
  return importAipackData(raw);
}

async function importAipackUrl(url) {
  requireGM();

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to download AI Patcher package: HTTP ${response.status}`);

  return importAipackData(await response.json());
}

async function importAipackData(raw) {
  requireGM();

  const packageData = validateAipack(raw);
  let assetMap = {};
  try {
    assetMap = await uploadAipackAssets(packageData.bundle.id, packageData.assets);
  } catch (error) {
    ui.notifications.warn(localize("notifications.assetsSkipped"));
    console.warn(`${MODULE_ID} | Unable to upload package assets`, error);
  }
  const importedBundles = foundry.utils.deepClone(game.settings.get(MODULE_ID, "importedBundles") ?? {});

  importedBundles[packageData.bundle.id] = {
    ...packageData.bundle,
    source: "imported",
    importedAt: new Date().toISOString(),
    patchSource: packageData.patchSource,
    assets: assetMap,
    assetBase: `worlds/${game.world.id}/${MODULE_ID}/${packageData.bundle.id}`
  };

  await game.settings.set(MODULE_ID, "importedBundles", importedBundles);
  ui.notifications.info(game.i18n.format(`${MODULE_ID}.notifications.imported`, { title: packageData.bundle.title }));
  return importedBundles[packageData.bundle.id];
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

async function showCatalogStatus() {
  const index = await loadInboxIndex();
  const feed = index.feed ?? lastFeedStatus;
  const remote = index.bundles.filter((bundle) => bundle.source === "remote");
  const imported = index.bundles.filter((bundle) => bundle.source === "imported");
  const local = index.bundles.filter((bundle) => bundle.source === "local");

  const content = `<p><strong>AI Patcher Catalog</strong></p>
<ul>
  <li><strong>${localize("catalog.status")}:</strong> ${feed.ok ? localize("catalog.ok") : localize("catalog.failed")}</li>
  <li><strong>${localize("catalog.url")}:</strong> <code>${escapeHTML(feed.url)}</code></li>
  <li><strong>${localize("catalog.remote")}:</strong> ${remote.length}</li>
  <li><strong>${localize("catalog.imported")}:</strong> ${imported.length}</li>
  <li><strong>${localize("catalog.local")}:</strong> ${local.length}</li>
  ${feed.error ? `<li><strong>${localize("catalog.error")}:</strong> <pre>${escapeHTML(feed.error)}</pre></li>` : ""}
</ul>`;

  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: "AI Patcher" }),
    content,
    whisper: [game.user.id]
  });
}

async function showHelp() {
  const content = `<p><strong>AI Patcher</strong></p>
<ul>
  <li><code>/aip inbox</code> - open the bundle inbox and import portable .aipack.json packages</li>
  <li><code>/aip catalog</code> - show remote catalog diagnostics</li>
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
  const feed = index.feed ?? lastFeedStatus;
  const hasBundles = bundles.length > 0;
  const importControl = `<div class="ai-patcher-import">
    <input type="file" accept=".json,.aipack,.aipack.json,application/json,text/json" data-action="select-aipack">
    <button type="button" data-action="import-aipack">
      <i class="fas fa-file-import"></i> ${localize(hasBundles ? "inbox.importFile" : "inbox.import")}
    </button>
  </div>`;

  if (!hasBundles) {
    return `<div class="ai-patcher-inbox">
      <div class="ai-patcher-feed-status ${feed.ok ? "is-ok" : "is-error"}">
        <strong>${localize("catalog.status")}:</strong> ${feed.ok ? localize("catalog.ok") : localize("catalog.failed")}
        <span>${escapeHTML(feed.url)}</span>
        ${feed.error ? `<pre>${escapeHTML(feed.error)}</pre>` : ""}
      </div>
      ${importControl}
      <p>${localize("inbox.empty")}</p>
      <p><code>Data/modules/ai-patcher/inbox/index.json</code></p>
    </div>`;
  }

  const rows = bundles.map((bundle) => {
    const id = escapeHTML(bundle.id);
    const title = escapeHTML(bundle.title || bundle.id);
    const description = escapeHTML(bundle.description || "");
    const createdAt = escapeHTML(bundle.createdAt || "");
    const source = escapeHTML(localize(`inbox.source.${bundle.source ?? "local"}`));
    const applyLabel = bundle.source === "remote" ? localize("inbox.importApply") : localize("inbox.apply");
    return `<article class="ai-patcher-bundle" data-bundle-id="${id}">
      <header>
        <h3>${title}</h3>
        <span>${source}${createdAt ? ` · ${createdAt}` : ""}</span>
      </header>
      ${description ? `<p>${description}</p>` : ""}
      <footer>
        <button type="button" data-action="dry-run" data-bundle-id="${id}">
          <i class="fas fa-vial"></i> ${localize("inbox.dryRun")}
        </button>
        <button type="button" data-action="apply" data-bundle-id="${id}">
          <i class="fas fa-check"></i> ${applyLabel}
        </button>
      </footer>
    </article>`;
  }).join("");

  return `<div class="ai-patcher-inbox">
    <div class="ai-patcher-feed-status ${feed.ok ? "is-ok" : "is-error"}">
      <strong>${localize("catalog.status")}:</strong> ${feed.ok ? game.i18n.format(`${MODULE_ID}.catalog.okCount`, { count: feed.count }) : localize("catalog.failed")}
      <span>${escapeHTML(feed.url)}</span>
      ${feed.error ? `<pre>${escapeHTML(feed.error)}</pre>` : ""}
    </div>
    ${rows}
    <details class="ai-patcher-manual-import">
      <summary>${localize("inbox.manualImport")}</summary>
      ${importControl}
    </details>
  </div>`;
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
      const importSelectedFile = async (input, button) => {
        const file = input?.files?.[0];
        if (!file) {
          input?.click();
          return;
        }

        button.disabled = true;
        try {
          await importAipackFile(file);
          dialog.close();
          openInbox();
        } catch (error) {
          ui.notifications.error(formatError(error));
          console.error(`${MODULE_ID} | ${formatError(error)}`);
        } finally {
          button.disabled = false;
          if (input) input.value = "";
        }
      };

      html.find("button[data-action='import-aipack']").on("click", async (event) => {
        const input = html.find("input[data-action='select-aipack']")[0];
        await importSelectedFile(input, event.currentTarget);
      });

      html.find("input[data-action='select-aipack']").on("change", async (event) => {
        const button = html.find("button[data-action='import-aipack']")[0];
        await importSelectedFile(event.currentTarget, button);
      });

      html.find("button[data-action='dry-run'], button[data-action='apply']").on("click", async (event) => {
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

  if (parsed.command === "catalog" || parsed.command === "status") {
    showCatalogStatus().catch((error) => console.error(`${MODULE_ID} | ${formatError(error)}`));
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

  game.settings.register(MODULE_ID, "importedBundles", {
    name: `${MODULE_ID}.settings.importedBundles.name`,
    hint: `${MODULE_ID}.settings.importedBundles.hint`,
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, "feedUrl", {
    name: `${MODULE_ID}.settings.feedUrl.name`,
    hint: `${MODULE_ID}.settings.feedUrl.hint`,
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_FEED_URL
  });
});

Hooks.once("ready", () => {
  game.aiPatcher = {
    openInbox,
    loadInboxIndex,
    importAipackFile,
    importAipackUrl,
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
