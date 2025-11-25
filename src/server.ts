import { OpenAIService } from "./openai-service";
import { OpenAIErrorResponse } from "./types";

const openAIService = new OpenAIService();

// Lấy Key từ environment
const SERVER_API_KEY = process.env.SERVER_API_KEY;

const server = Bun.serve({
  port: process.env.PORT || 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    };

    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // Health Check
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
            param: null,
            code: "invalid_api_key",
          }
        }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    try {
      if (url.pathname === "/v1/models" && req.method === "GET") {
        const models = openAIService.getModels();
        return new Response(JSON.stringify(models), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

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

      return new Response(JSON.stringify({ error: { message: "Not Found" } }), { status: 404, headers: corsHeaders });
    } catch (error: any) {
      console.error(error);
      return new Response(JSON.stringify({ error: { message: error.message || "Internal Error" } }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  },
});

console.log(`🚀 Server running on port ${server.port}`);
console.log(SERVER_API_KEY ? "🔒 API Key Protected" : "⚠️  Public API (No Key)");
