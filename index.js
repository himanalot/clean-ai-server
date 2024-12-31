import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { registerOutboundRoutes } from "./outbound-calls.js";

const fastify = Fastify({
  logger: true
});

await fastify.register(websocket);
registerOutboundRoutes(fastify);

try {
  await fastify.listen({ port: process.env.PORT || 8080, host: '0.0.0.0' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
