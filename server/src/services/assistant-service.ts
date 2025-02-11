import { AssistantDefinition } from "../types/Assistant";
import EventEmitter from "events";
import Airtable, { Table, FieldSet } from "airtable";
import { AirtableBase } from "airtable/lib/airtable_base";

export class AssistantService extends EventEmitter {
  private assistants: AssistantDefinition[] = [];
  private base: AirtableBase;
  private table: Table<FieldSet>;

  // Instantiation
  constructor() {
    super();
    // Authenticate
    Airtable.configure({
      apiKey: process.env.AIRTABLE_TOKEN,
    });

    // Initialize a base
    this.base = Airtable.base(process.env.AIRTABLE_BASE_ID || "");

    // Reference a table
    this.table = this.base(process.env.AIRTABLE_TABLE_NAME || "");
  }

  async getAssistant(target_name: string) {
    console.log(`Assistant service has ${this.assistants.length} in cache`);
    if (this.assistants?.length === 0) {
      console.log(`Attempting to fetch assistants`);
      const fetched_assistants = await this.getAssistants();
      if (fetched_assistants) this.assistants = fetched_assistants;
    }

    if (this.assistants === undefined || this.assistants.length === 0)
      return undefined;

    const match = this.assistants.find((a) => a.assistant_name === target_name);
    console.log(`Looking for an assistant named ${target_name}, matched`);
    return match;
  }

  async getAssistants() {
    try {
      let entries: Array<AssistantDefinition> =
        new Array<AssistantDefinition>();

      await this.table
        .select({
          view: process.env.AIRTABLE_VIEW,
        })
        .eachPage(function page(
          records: readonly Record<string, any>[],
          fetchNextPage: any
        ) {
          // This function (`page`) will get called for each page of records.
          records.forEach((record) => {
            // console.log("Record", record);
            entries.push({
              vertical: record.get("Vertical") as string,
              company_name: record.get("Company Name") as string,
              assistant_name: record.get("Assistant Name") as string,
              initial_message: record.get("Initial Message") as string,
              instructions: record.get("Instructions") as string,
              additional_context: record.get("Additional Context") as string,
              llm_provider: (record.get("LLM Provider") as string) || "openai",
              tts_provider: (record.get("TTS Provider") as string) || "google",
              tts_voice:
                (record.get("TTS Voice") as string) || "en-US-Journey-O",
              language_code: (record.get("Language Code") as string) || "en-US",
              stt_provider: (record.get("STT Provider") as string) || "google",
              stt_model: (record.get("STT Model") as string) || "telephony",
            });
          });

          // To fetch the next page of records, call `fetchNextPage`.
          // If there are more records, `page` will get called again.
          // If there are no more records, `done` will get called.
          fetchNextPage();
        });

      this.assistants = entries;
      return entries;
    } catch (error) {
      console.error("Error fetching assistant definition", error);
      this.emit("error", error);
    }
  }
}
