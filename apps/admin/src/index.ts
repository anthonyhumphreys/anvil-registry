import { loadConfig } from "@anvil/config";
import { buildAdmin } from "./app.js";

const config = loadConfig();
const port = Number(process.env.ADMIN_PORT ?? 3000);
const host = process.env.ADMIN_HOST ?? config.HOST;
const app = buildAdmin({ config });

await app.listen({ host, port });
