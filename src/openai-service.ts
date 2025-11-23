import { DuckAI } from "./duckai";
import { ToolService } from "./tool-service";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ModelsResponse,
} from "./types";

export class OpenAIService {
  private duckAI: DuckAI;
  private toolService: ToolService;

  constructor() {
    this.duckAI = new DuckAI();
    this.toolService = new ToolService();
  }

  getModels(): ModelsResponse {
    // Gọi hàm getAvailableModels từ file gốc
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
    
    // Đảm bảo content là string
    for (const msg of request.messages) {
      if (msg.role === "tool") continue;
      if (typeof msg.content !== "string" && msg.content !== null) {
        if (Array.isArray(msg.content)) {
           msg.content = msg.content
             .filter((c: any) => c.type === 'text')
             .map((c: any) => c.text)
             .join('\n');
        } else {
            msg.content = String(msg.content || "");
        }
      }
    }

    if (!request.model) request.model = "gpt-4o-mini";
    return request as ChatCompletionRequest;
  }

  // Xử lý Non-Streaming (Chờ hết nội dung rồi trả về 1 lần)
  async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    // Xử lý System Prompt cho Tools nếu cần
    let messages = [...request.messages];
    if (request.tools && request.tools.length > 0) {
      const toolPrompt = this.toolService.generateToolSystemPrompt(request.tools, request.tool_choice);
      const lastUserMsgIndex = messages.findLastIndex(m => m.role === 'user');
      if (lastUserMsgIndex !== -1) {
         messages[lastUserMsgIndex].content += `\n\n${toolPrompt}`;
      } else {
         messages.unshift({ role: "system", content: toolPrompt });
      }
    }

    // Gọi DuckAI gốc
    const stream = await this.duckAI.chat(request.model, messages);
    const reader = stream.getReader();
    
    let fullContent = "";
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // FILE GỐC TRẢ VỀ STRING, KHÔNG CẦN DECODE
        if (value) fullContent += value; 
      }
    } finally {
      reader.releaseLock();
    }

    const promptTokens = this.estimateTokens(JSON.stringify(messages));
    const completionTokens = this.estimateTokens(fullContent);

    return {
      id: this.generateId(),
      object: "chat.completion",
      created: this.getCurrentTimestamp(),
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: fullContent,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    };
  }

  // Xử lý Streaming (SSE)
  async createChatCompletionStream(request: ChatCompletionRequest): Promise<ReadableStream<Uint8Array>> {
    const encoder = new TextEncoder(); // Encode output ra client thì vẫn cần
    const id = this.generateId();
    const created = this.getCurrentTimestamp();
    const model = request.model;

    let messages = [...request.messages];
    if (request.tools && request.tools.length > 0) {
       const toolPrompt = this.toolService.generateToolSystemPrompt(request.tools, request.tool_choice);
       const lastUserMsgIndex = messages.findLastIndex(m => m.role === 'user');
       if (lastUserMsgIndex !== -1) {
          messages[lastUserMsgIndex].content += `\n\n${toolPrompt}`;
       }
    }

    // Gọi DuckAI gốc
    const duckStream = await this.duckAI.chat(request.model, messages);
    const duckReader = duckStream.getReader();

    let completionTokens = 0;
    const promptTokens = this.estimateTokens(JSON.stringify(messages));

    return new ReadableStream({
      async start(controller) {
        // Gửi chunk mở đầu
        const roleChunk: ChatCompletionChunk = {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));

        try {
          while (true) {
            const { done, value } = await duckReader.read();
            if (done) break;

            // QUAN TRỌNG: File gốc trả về value là String (text), không phải Uint8Array
            const textChunk = value; 
            
            if (!textChunk) continue;

            completionTokens++;

            const chunk: ChatCompletionChunk = {
              id, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: { content: textChunk }, finish_reason: null }]
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // Gửi chunk kết thúc (STOP)
          const stopChunk: ChatCompletionChunk = {
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`));

          // Gửi usage (nếu client hỗ trợ)
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

          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (e) {
          console.error("Streaming error inside service:", e);
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
