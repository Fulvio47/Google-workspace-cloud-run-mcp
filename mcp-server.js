import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { google } from 'googleapis';
import { z } from 'zod';
import express from 'express';

// 1. Setup Express
const app = express();
const server = new McpServer({
  name: "google-workspace-master-agent",
  version: "1.0.0",
});

// 2. Authentication Setup
const auth = new google.auth.GoogleAuth({
  scopes: [
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file'
  ],
});

/**
 * --- RESILIENT RETRY WRAPPER ---
 */
async function callWithRetry(apiFunc, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await apiFunc();
    } catch (error) {
      if (attempt < maxRetries && (error.code === 503 || error.code === 429 || error.code === 408)) {
        const delay = attempt * 2000; 
        console.log(`Cloud warming up (Attempt ${attempt})... Retrying in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

/**
 * --- TOOLS ---
 */
server.tool("create_google_doc", {
    title: z.string().describe("The title of the new document"),
    content: z.string().describe("The text content to put inside")
  },
  async ({ title, content }) => {
    return await callWithRetry(async () => {
      const docs = google.docs({ version: 'v1', auth });
      const doc = await docs.documents.create({ requestBody: { title } });
      const documentId = doc.data.documentId;
      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [{ insertText: { endOfSectionLocation: {}, text: content } }]
        }
      });
      return { content: [{ type: "text", text: `Created: ${title} (ID: ${documentId})` }] };
    });
  }
);

server.tool("list_drive_files", {
    pageSize: z.number().default(10)
  },
  async ({ pageSize }) => {
    return await callWithRetry(async () => {
      const drive = google.drive({ version: 'v3', auth });
      const res = await drive.files.list({ pageSize, fields: 'files(id, name)' });
      const fileList = res.data.files?.map(f => `${f.name} (${f.id})`).join('\n') || "No files.";
      return { content: [{ type: "text", text: fileList }] };
    });
  }
);

// --- SSE ROUTING FIX FOR LOBECHAT ---
let transport;

app.get("/sse", async (req, res) => {
  console.log("New SSE connection established");
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  console.log("Received message from client");
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No active SSE session");
  }
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Master Agent live at http://0.0.0.0:${PORT}`);
});
