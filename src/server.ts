// server.ts
import { OpenAIService } from "./openai-service";
import { OpenAIErrorResponse } from "./types";

const openAIService = new OpenAIService();

// Lấy API Key từ biến môi trường
const SERVER_API_KEY = process.env.SERVER_API_KEY;

if (!SERVER_API_KEY) {
  console.warn("⚠️  WARNING: SERVER_API_KEY is not set in environment variables.");
  console.warn("⚠️  The API is currently OPEN to the public without authentication!");
}

const server = Bun.serve({
  port: process.env.PORT || 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // Standard CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    };

    // 1. Handle Preflight (OPTIONS) - Luôn cho phép để trình duyệt không chặn
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 2. Handle Health Check - Public endpoint (cho Load Balancer/Monitor)
    if (url.pathname === "/health" && req.method === "GET") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // 3. AUTHENTICATION MIDDLEWARE
    // Chỉ kiểm tra Auth nếu SERVER_API_KEY đã được thiết lập
    if (SERVER_API_KEY) {
      const authHeader = req.headers.get("Authorization");
      
      // Chuẩn: "Bearer <token>"
      // Kiểm tra xem header có tồn tại và token có khớp không
      if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== SERVER_API_KEY) {
        // Trả về lỗi 401 Unauthorized chuẩn OpenAI
        const errorResponse: OpenAIErrorResponse = {
          error: {
            message: "Incorrect API key provided. You can find your API key in your configuration.",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          }
        };

        return new Response(JSON.stringify(errorResponse), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // =================================================================
    // MAIN API LOGIC
    // =================================================================
    try {
      // Models endpoint
      if (url.pathname === "/v1/models" && req.method === "GET") {
        const models = openAIService.getModels();
        return new Response(JSON.stringify(models), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Chat completions endpoint
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const body = await req.json();
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
      return new Response(
        JSON.stringify({
          error: {
            message: `Invalid URL (${req.method} ${url.pathname})`,
            type: "invalid_request_error",
            param: null,
            code: "invalid_url",
          },
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );

    } catch (error: any) {
      console.error("Server error:", error);

      const statusCode = error.message.includes("Invalid") || error.message.includes("must") ? 400 : 500;
      const errorResponse: OpenAIErrorResponse = {
        error: {
          message: error.message || "Internal server error",
          type: statusCode === 400 ? "invalid_request_error" : "internal_server_error",
          param: null,
          code: statusCode === 500 ? "internal_error" : null,
        }
      };

      return new Response(JSON.stringify(errorResponse), {
        status: statusCode,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  },
});

console.log(`🚀 OpenAI-compatible server running on http://localhost:${server.port}`);
if (SERVER_API_KEY) {
  console.log(`🔒 Security: ENABLED (API Key protection active)`);
} else {
  console.log(`🔓 Security: DISABLED (Warning: API is public)`);
}
