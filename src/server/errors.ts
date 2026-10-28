import OpenAI from "openai";

function providerHint(status: number | undefined): string {
  let hint = "Check that the model supports streamed tool calls.";
  if (status === 401 || status === 403) {
    hint = "Check OPENAI_API_KEY and OPENAI_BASE_URL.";
  } else if (status === 404) {
    hint = "Check that OPENAI_MODEL exists for this provider.";
  } else if (status === 429) {
    hint = "Rate limit or quota reached. Wait a minute, or check your plan.";
  } else if (status !== undefined && status >= 500) {
    hint = "The provider is overloaded or unavailable. Try again shortly or choose another model.";
  }
  return hint;
}

export function describeRunError(error: unknown, aborted: boolean): string {
  let message = error instanceof Error ? error.message : "Agent run failed.";
  if (aborted) {
    message = "Run stopped or timed out. Approved file actions are not rolled back.";
  } else if (error instanceof OpenAI.APIConnectionTimeoutError) {
    message = "The model provider did not respond in time. It may be overloaded; try again or choose another model.";
  } else if (error instanceof OpenAI.APIConnectionError) {
    message = "Could not reach the model provider. Check your network and OPENAI_BASE_URL.";
  } else if (error instanceof OpenAI.APIError) {
    message = `Model provider request failed (HTTP ${error.status ?? "unknown"}). ${providerHint(error.status)}`;
  }
  return message;
}
