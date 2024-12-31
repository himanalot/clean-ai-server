import WebSocket from "ws";
import Twilio from "twilio";

export function registerOutboundRoutes(fastify) {
  // Remove environment variable checks since we'll use user-provided credentials
  
  fastify.post("/outbound-call", async (request, reply) => {
    const { 
      number, 
      prompt, 
      firstMessage,
      elevenLabsKey,
      agentId,
      twilioSid,
      twilioToken,
      fromNumber 
    } = request.body;

    // Validate all required fields
    if (!number || !prompt || !firstMessage || !elevenLabsKey || !agentId || 
        !twilioSid || !twilioToken || !fromNumber) {
      return reply.code(400).send({ 
        success: false, 
        error: "Missing required parameters" 
      });
    }

    try {
      // Initialize Twilio with user's credentials
      const twilioClient = new Twilio(twilioSid, twilioToken);

      const call = await twilioClient.calls.create({
        from: fromNumber,
        to: number,
        url: `https://${request.headers.host}/outbound-call-twiml?prompt=${encodeURIComponent(prompt)}&firstMessage=${encodeURIComponent(firstMessage)}&elevenLabsKey=${encodeURIComponent(elevenLabsKey)}&agentId=${encodeURIComponent(agentId)}`
      });

      reply.send({ 
        success: true, 
        callSid: call.sid 
      });
    } catch (error) {
      console.error("Error initiating call:", error);
      reply.code(500).send({ 
        success: false, 
        error: error.message || "Failed to initiate call" 
      });
    }
  });

  fastify.all("/outbound-call-twiml", async (request, reply) => {
    const { prompt, firstMessage, elevenLabsKey, agentId } = request.query;

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
            <Parameter name="firstMessage" value="${firstMessage}" />
            <Parameter name="elevenLabsKey" value="${elevenLabsKey}" />
            <Parameter name="agentId" value="${agentId}" />
          </Stream>
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/outbound-media-stream", { websocket: true }, (ws, req) => {
      let streamSid = null;
      let customParameters = null;
      let elevenLabsWs = null;

      const setupElevenLabs = async () => {
        try {
          // Use the provided ElevenLabs credentials
          const signedUrl = await getSignedUrl(
            customParameters.elevenLabsKey,
            customParameters.agentId
          );
          
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected");
            
            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: { prompt: customParameters.prompt },
                  first_message: customParameters.firstMessage,
                },
              }
            };

            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          // Rest of WebSocket handling...
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      // Handle messages from Twilio
      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);
          
          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              customParameters = msg.start.customParameters;
              setupElevenLabs();
              break;
            // Rest of the message handling...
          }
        } catch (error) {
          console.error("[Twilio] Error:", error);
        }
      });
    });
  });
}

// Helper function to get signed URL using provided credentials
async function getSignedUrl(apiKey, agentId) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
    {
      headers: {
        'xi-api-key': apiKey
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to get signed URL: ${response.statusText}`);
  }

  const data = await response.json();
  return data.signed_url;
} 