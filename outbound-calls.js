import WebSocket from "ws";
import Twilio from "twilio";

export function registerOutboundRoutes(fastify) {
  // Add form body parser
  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, function (req, body, done) {
    try {
      const parsed = new URLSearchParams(body);
      const result = {};
      for (const [key, value] of parsed) {
        result[key] = value;
      }
      done(null, result);
    } catch (err) {
      done(err);
    }
  });

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

  fastify.route({
    method: ['GET', 'POST'],
    url: '/outbound-call-twiml',
    handler: async (request, reply) => {
      // Get parameters from either query or body
      const params = request.method === 'GET' ? request.query : request.body;
      
      console.log('TwiML request:', {
        method: request.method,
        params,
        query: request.query,
        body: request.body,
        headers: request.headers
      });

      // Get parameters from either source
      const prompt = params.prompt || request.query.prompt;
      const firstMessage = params.firstMessage || request.query.firstMessage;
      const elevenLabsKey = params.elevenLabsKey || request.query.elevenLabsKey;
      const agentId = params.agentId || request.query.agentId;

      // Log the parameters we're using
      console.log('Using parameters:', { prompt, firstMessage, elevenLabsKey, agentId });

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
    }
  });

  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/outbound-media-stream", { websocket: true }, (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      // Variables to track the call
      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;

      // Handle WebSocket errors
      ws.on('error', console.error);

      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl(
            customParameters.elevenLabsKey,
            customParameters.agentId
          );
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: { prompt: customParameters.prompt },
                  first_message: customParameters.firstMessage,
                },
              }
            };

            console.log("[ElevenLabs] Sending initial config with prompt:", initialConfig.conversation_config_override.agent.prompt.prompt);
            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  break;

                case "audio":
                  if (streamSid) {
                    if (message.audio?.chunk) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio.chunk
                        }
                      };
                      ws.send(JSON.stringify(audioData));
                    } else if (message.audio_event?.audio_base_64) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio_event.audio_base_64
                        }
                      };
                      ws.send(JSON.stringify(audioData));
                    }
                  } else {
                    console.log("[ElevenLabs] Received audio but no StreamSid yet");
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(JSON.stringify({ 
                      event: "clear",
                      streamSid 
                    }));
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(JSON.stringify({
                      type: "pong",
                      event_id: message.ping_event.event_id
                    }));
                  }
                  break;

                default:
                  console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", () => {
            console.log("[ElevenLabs] Disconnected");
          });

        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      // Handle messages from Twilio
      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);
          console.log(`[Twilio] Received event: ${msg.event}`);

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;
              console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
              console.log('[Twilio] Start parameters:', customParameters);
              setupElevenLabs();
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      // Handle WebSocket closure
      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
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