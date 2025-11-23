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
    // Lấy danh sách model từ file gốc
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
    
    // Validate và ép kiểu content về string
    for (const msg of request.messages) {
      if (msg.role === "tool") continue;
      if (typeof msg.content !== "string" && msg.content !== null) {
        if (Array.isArray(msg.content)) {
           // Handle multi-modal array (chỉ lấy text)
           msg.content = msg.content
             .filter((c: any) => c.type === 'text')
             .map((c: any) => c.text)
             .join('\n');
        } else {
            msg.content = String(msg.content || "");
        }
      }
    }

    // Default model
    if (!request.model) request.model = "gpt-4o-mini";
    
    return request as ChatCompletionRequest;
  }

  /**
   * CHUẨN HÓA MESSAGES TRƯỚC KHI GỬI CHO DUCKAI
   * DuckDuckGo hay bị lỗi 500 nếu gặp role="system".
   * Hàm này sẽ gộp System Prompt vào User Message đầu tiên.
   */
  private formatMessagesForDuckAI(
    messages: ChatCompletionMessage[], 
    tools?: any[], 
    toolChoice?: any
  ): ChatCompletionMessage[] {
    let finalMessages = [...messages];
    let systemInstructions = "";

    // 1. Xử lý Tools Instruction (nếu có)
    if (tools && tools.length > 0) {
      const toolPrompt = this.toolService.generateToolSystemPrompt(tools, toolChoice);
      systemInstructions += `${toolPrompt}\n\n`;
    }

    // 2. Tìm và rút các System Message ra
    const systemMsgs = finalMessages.filter(m => m.role === "system");
    if (systemMsgs.length > 0) {
      systemInstructions += systemMsgs.map(m => m.content).join("\n\n") + "\n\n";
      // Loại bỏ system message khỏi mảng gốc để tránh gửi role "system"
      finalMessages = finalMessages.filter(m => m.role !== "system");
    }

    // 3. Nếu có system instruction, gộp vào User Message đầu tiên hoặc cuối cùng
    if (systemInstructions.trim().length > 0) {
      // Tìm tin nhắn user gần nhất (thường là cái cuối cùng hoặc đầu tiên)
      const lastUserIndex = finalMessages.findLastIndex(m => m.role === "user");
      
      if (lastUserIndex !== -1) {
        // Prepend vào tin nhắn user
        finalMessages[lastUserIndex].content = 
          `[System Instructions]:\n${systemInstructions}\n\n[User Message]:\n${finalMessages[lastUserIndex].content}`;
      } else {
        // Nếu không có user message nào (hiếm), tạo mới
        finalMessages.push({ role: "user", content: systemInstructions });
      }
    }

    // 4. Đảm bảo role chỉ là "user" hoặc "assistant" (DuckAI đôi khi map assistant -> model nội bộ)
    // Các role khác có thể gây lỗi.
    return finalMessages.map(m => ({
      role: m.role === "assistant" ? "assistant" : "user", // Ép về user nếu là tool/system lọt lưới
      content: m.content || ""
    }));
  }

  // --- Xử lý Non-Streaming ---
  async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    // Chuẩn hóa message để tránh lỗi 500
    const safeMessages = this.formatMessagesForDuckAI(request.messages, request.tools, request.tool_choice);

    const stream = await this.duckAI.chat(request.model, safeMessages);
    const reader = stream.getReader();
    
    let fullContent = "";
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) fullContent += value; 
      }
    } finally {
      reader.releaseLock();
    }

    const promptTokens = this.estimateTokens(JSON.stringify(safeMessages));
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

  // --- Xử lý Streaming (SSE) ---
  async createChatCompletionStream(request: ChatCompletionRequest): Promise<ReadableStream<Uint8Array>> {
    const encoder = new TextEncoder();
    const id = this.generateId();
    const created = this.getCurrentTimestamp();
    const model = request.model;

    // Chuẩn hóa message để tránh lỗi 500
    const safeMessages = this.formatMessagesForDuckAI(request.messages, request.tools, request.tool_choice);

    const duckStream = await this.duckAI.chat(request.model, safeMessages);
    const duckReader = duckStream.getReader();

    let completionTokens = 0;
    const promptTokens = this.estimateTokens(JSON.stringify(safeMessages));

    return new ReadableStream({
      async start(controller) {
        // Chunk mở đầu
        const roleChunk: ChatCompletionChunk = {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));

        try {
          while (true) {
            const { done, value } = await duckReader.read();
            if (done) break;

            const textChunk = value; // File gốc trả về string
            
            if (!textChunk) continue;

            completionTokens++;

            const chunk: ChatCompletionChunk = {
              id, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: { content: textChunk }, finish_reason: null }]
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // Chunk kết thúc
          const stopChunk: ChatCompletionChunk = {
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`));

          // Chunk usage
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
