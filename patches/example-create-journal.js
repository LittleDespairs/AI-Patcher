export default async function exampleCreateJournal({ dryRun, log }) {
  const name = "Codex patch smoke test";
  log(`Preparing journal entry: ${name}`);

  if (dryRun) {
    return {
      wouldCreate: {
        type: "JournalEntry",
        name
      }
    };
  }

  const entry = await JournalEntry.create({
    name,
    pages: [
      {
        name: "Result",
        type: "text",
        text: {
          format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML,
          content: "<p>AI Patcher is installed and can write to this world.</p>"
        }
      }
    ]
  });

  return {
    created: {
      type: "JournalEntry",
      id: entry.id,
      name: entry.name
    }
  };
}
