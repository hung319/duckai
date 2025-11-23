// openai-service.ts
import { DuckAI } from "./duckai";
import { ToolService } from "./tool-service";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ModelsResponse,
  Model,
  ChatCompletionUsage,
} from "./types";

export class OpenAIService {
  private duckAI: DuckAI;
  private toolService: ToolService;

  constructor() {
    this.duckAI = new DuckAI();
    this.toolService = new ToolService();
  }

  getModels(): ModelsResponse {
    const modelIds = this.duckAI.getAvailableModels();
    const now = Math.floor(Date.now() / 1000);
    
    return {
      object: "list",
      data: modelIds.map(id => ({
        id: id,
        object: "model",
        created: now,
        owned_by: "duckai-wrapper"
      }))
    };
  }

  validateRequest(request: any): ChatCompletionRequest {
    if (!request.messages || !Array.isArray(request.messages)) {
      throw new Error("messages array is required");
    }
    
    // Ensure content is string (handle array content in newer GPT-4 vision api if needed, strictly string for now)
    for (const msg of request.messages) {
      if (msg.role === "tool") continue; // Tool messages might have complex content
      if (typeof msg.content !== "string" && msg.content !== null) {
        // Simplified validation: Convert non-string to string if possible or throw
        if (Array.isArray(msg.content)) {
           // Basic handling for multi-modal content array (just extract text)
           msg.content = msg.content
             .filter((c: any) => c.type === 'text')
             .map((c: any) => c.text)
             .join('\n');
        }
      }
    }

    // Default model if not provided
    if (!request.model) request.model = "gpt-4o-mini";

    return request as ChatCompletionRequest;
  }

  async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    // Handling Tools:
    // If tools are present, we modify the last user message to include instructions
    // This is a naive implementation. For robust tool use, we'd need a multi-turn loop.
    let messages = [...request.messages];
    if (request.tools && request.tools.length > 0) {
      const toolPrompt = this.toolService.generateToolSystemPrompt(request.tools, request.tool_choice);
      // Inject into the last user message or system message
      const lastUserMsgIndex = messages.findLastIndex(m => m.role === 'user');
      if (lastUserMsgIndex !== -1) {
         messages[lastUserMsgIndex].content += `\n\n${toolPrompt}`;
      } else {
         // Fallback: add as system message
         messages.unshift({ role: "system", content: toolPrompt });
      }
    }

    // Call DuckAI
    // Note: DuckAI returns a stream normally. We need to collect it for non-streaming response.
    const stream = await this.duckAI.chat(request.model, messages);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    
    let fullContent = "";
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullContent += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }

    // Parse for Tool Calls (naive JSON check)
    // If content looks like JSON tool call, parse it.
    // NOTE: In a real "proxy", we should return the tool_call object, not execute it.
    // Client executes -> sends result -> model responds.
    
    // Construct Usage
    const promptTokens = this.estimateTokens(JSON.stringify(messages));
    const completionTokens = this.estimateTokens(fullContent);

    return {
      id: this.generateId(),
      object: "chat.completion",
      created: this.getCurrentTimestamp(),
      model: request.model,
      system_fingerprint: "fp_duckai_wrapper",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: fullContent, // TODO: Extract tool calls if JSON
            tool_calls: undefined, // Add logic here if parsing JSON
          },
          finish_reason: "stop", // or "tool_calls"
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    };
  }

  async createChatCompletionStream(request: ChatCompletionRequest): Promise<ReadableStream<Uint8Array>> {
    const encoder = new TextEncoder();
    const id = this.generateId();
    const created = this.getCurrentTimestamp();
    const model = request.model;

    // Inject tools instructions similar to non-streaming
    let messages = [...request.messages];
    if (request.tools && request.tools.length > 0) {
       const toolPrompt = this.toolService.generateToolSystemPrompt(request.tools, request.tool_choice);
       const lastUserMsgIndex = messages.findLastIndex(m => m.role === 'user');
       if (lastUserMsgIndex !== -1) {
          messages[lastUserMsgIndex].content += `\n\n${toolPrompt}`;
       }
    }

    // Get upstream stream
    const duckStream = await this.duckAI.chat(request.model, messages);
    const duckReader = duckStream.getReader();
    const decoder = new TextDecoder();

    // Token estimation
    let completionTokens = 0;
    const promptTokens = this.estimateTokens(JSON.stringify(messages));

    return new ReadableStream({
      async start(controller) {
        // Send initial chunk with role
        const roleChunk: ChatCompletionChunk = {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));

        try {
          while (true) {
            const { done, value } = await duckReader.read();
            if (done) break;

            const textChunk = decoder.decode(value, { stream: true });
            if (!textChunk) continue;

            completionTokens++; // Rough count

            const chunk: ChatCompletionChunk = {
              id, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: { content: textChunk }, finish_reason: null }]
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // Send final stop chunk
          const stopChunk: ChatCompletionChunk = {
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`));

          // Send usage chunk (if requested or by default for some clients)
          if (request.stream_options?.include_usage) {
             const usageChunk: ChatCompletionChunk = {
                id, object: "chat.completion.chunk", created, model,
                choices: [],
                usage: {
                   prompt_tokens: promptTokens,
                   completion_tokens: completionTokens,
                   total_tokens: promptTokens + completionTokens
                }
             };
             controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
          }

          // Send [DONE]
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (e) {
          console.error("Streaming error", e);
          controller.error(e);
        } finally {
          controller.close();
          duckReader.releaseLock();
        }
      }
    });
  }

  private generateId(): string {
    return `chatcmpl-${Math.random().toString(36).substring(2, 15)}`;
  }

  private getCurrentTimestamp(): number {
    return Math.floor(Date.now() / 1000);
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
