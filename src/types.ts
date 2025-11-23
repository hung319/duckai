// types.ts

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface FunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
}

export interface ToolDefinition {
  type: "function";
  function: FunctionDefinition;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  stream_options?: {
    include_usage?: boolean;
  };
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
  logprobs?: any;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
  logprobs?: any;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: ChatCompletionChunkChoice[];
  usage?: ChatCompletionUsage; // OpenAI now supports usage in the last chunk
}

export interface ModelsResponse {
  object: "list";
  data: Model[];
}

export interface Model {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface DuckAIRequest {
  model: string;
  messages: ChatCompletionMessage[];
}

// Error Response Types
export interface OpenAIError {
  message: string;
  type: string;
  param: string | null;
  code: string | null;
}

export interface OpenAIErrorResponse {
  error: OpenAIError;
}
