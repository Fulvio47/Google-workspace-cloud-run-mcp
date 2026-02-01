import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { google } from 'googleapis';
import { z } from 'zod';
import express from 'express';

// 1. Setup Express for SSE
const app = express();
const server = new McpServer({
  name: "google-workspace-master-agent",
  version: "1.0.0",
});

// 2. Authentication Setup (Uses Service Account from Cloud Run environment)
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
 * This ensures the agent doesn't fail during a "Cold Start" on the Free Tier.
 */
async function callWithRetry(apiFunc, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await apiFunc();
    } catch (error) {
      // 503 is service unavailable (waking up), 429 is rate limit, 408 is timeout
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
 * --- TOOL: CREATE GOOGLE DOC (The "Writer") ---
 */
server.tool(
  "create_google_doc",
  {
    title: z.string().describe("The title of the new document"),
    content: z.string().describe("The text content to put inside the document")
  },
  async ({ title, content }) => {
    return await callWithRetry(async () => {
      const docs = google.docs({ version: 'v1', auth });
      // Create the document
      const doc = await docs.documents.create({ requestBody: { title } });
      const documentId = doc.data.documentId;

      // Add the content
      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [{
            insertText: { endOfSectionLocation: {}, text: content }
          }]
        }
      });

      return {
        content: [{ type: "text", text: `Successfully created "${title}" (ID: ${documentId}).` }]
      };
    });
  }
);

/**
 * --- TOOL: LIST DRIVE FILES (The "Reader") ---
 */
server.tool(
  "list_drive_files",
  {
    pageSize: z.number().default(10).describe("Number of files to list")
  },
  async ({ pageSize }) => {
    return await callWithRetry(async () => {
      const drive = google.drive({ version: 'v3', auth });
      const res = await drive.files.list({
        pageSize,
        fields: 'files(id, name, mimeType)',
      });
      const files = res.data.files;
      if (!files || files.length === 0) {
        return { content: [{ type: "text", text: "No files found." }] };
      }
      const fileList = files.map(f => `${f.name} (ID: ${f.id})`).join('\n');
      return { content: [{ type: "text", text: `Files found:\n${fileList}` }] };
    });
  }
);

// ... existing code above ...

// 3. SSE Endpoint for LobeChat to connect
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  await server.handleMessage(req, res);
});

// CRITICAL FIX: Use 0.0.0.0 and process.env.PORT for Cloud Run compatibility
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Master Agent listening on port ${PORT} at 0.0.0.0`);
});
