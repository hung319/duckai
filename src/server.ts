import { OpenAIService } from "./openai-service";
// import { OpenAIErrorResponse } from "./types"; // (Nếu bạn cần type này)

const openAIService = new OpenAIService();
const SERVER_API_KEY = process.env.SERVER_API_KEY;

const server = Bun.serve({
  port: process.env.PORT || 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // --- CORS CONFIGURATION ---
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    };

    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // --- HEALTH CHECK ---
    if (url.pathname === "/health" && req.method === "GET") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // --- AUTHENTICATION CHECK ---
    if (SERVER_API_KEY) {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== SERVER_API_KEY) {
        return new Response(JSON.stringify({
          error: {
            message: "Incorrect API key.",
            type: "invalid_request_error",
            code: "invalid_api_key",
          }
        }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // --- MAIN LOGIC ---
    try {
      // 1. List Models
      if (url.pathname === "/v1/models" && req.method === "GET") {
        const models = openAIService.getModels();
        return new Response(JSON.stringify(models), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // 2. Chat Completions
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        let body;
        try {
          body = await req.json();
        } catch (e) {
          // Bắt lỗi cú pháp JSON ngay tại đây (ví dụ: thiếu dấu ngoặc })
          return new Response(JSON.stringify({ error: { message: "Invalid JSON format" } }), {
             status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } 
          });
        }

        // Validate request (Có thể ném lỗi nếu thiếu field)
        const validatedRequest = openAIService.validateRequest(body);

        if (validatedRequest.stream) {
          const stream = await openAIService.createChatCompletionStream(validatedRequest);
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              ...corsHeaders,
            },
          });
        } else {
          const response = await openAIService.createChatCompletion(validatedRequest);
          return new Response(JSON.stringify(response), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
      }

      // 404 Not Found
      return new Response(JSON.stringify({ error: { message: "Not Found" } }), { 
        status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } 
      });

    } catch (error: any) {
      console.error("[ServerError]", error);
      
      const errorMessage = error.message || "Internal Server Error";
      
      // [FIX] Phân loại lỗi để trả về status code đúng
      // Nếu lỗi chứa từ khóa validation (từ openai-service), trả về 400
      const isValidationError = 
        errorMessage.includes("required") || 
        errorMessage.includes("invalid") || 
        errorMessage.includes("must be");

      return new Response(JSON.stringify({ 
        error: { 
          message: errorMessage,
          type: isValidationError ? "invalid_request_error" : "internal_error"
        } 
      }), {
        status: isValidationError ? 400 : 500, // 400 cho user sai, 500 cho server lỗi
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  },
});

console.log(`🚀 Server running on port ${server.port}`);
console.log(SERVER_API_KEY ? "🔒 API Key Protected" : "⚠️  Public API (No Key)");
