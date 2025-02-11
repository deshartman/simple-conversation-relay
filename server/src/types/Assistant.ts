export type AssistantDefinition = {
  vertical: string;
  initial_message: string;
  company_name: string;
  assistant_name: string;
  instructions: string;
  additional_context: string;
  tools?: [];
  llm_provider: string;
  tts_provider: string;
  tts_voice: string;
  language_code: string;
  stt_provider: string;
  stt_model: string;
};
