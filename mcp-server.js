import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { google } from 'googleapis';
import { z } from "zod";

// 1. Initialize the Master MCP Server
const server = new McpServer({
  name: "MasterWorkspaceAgent",
  version: "1.0.0",
});

// 2. Automated Google Auth (Designed for Cloud Run Service Accounts)
const auth = new google.auth.GoogleAuth({
  scopes: [
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.readonly'
  ],
});

/**
 * --- TOOL: READ GOOGLE DOC ---
 * Aggregated from 'taylorwilsdon/google_workspace_mcp'
 */
server.tool(
  "read_google_doc",
  { documentId: z.string().describe("The ID of the Google Doc (found in the URL)") },
  async ({ documentId }) => {
    try {
      const docs = google.docs({ version: 'v1', auth });
      const res = await docs.documents.get({ documentId });
      let content = "";
      res.data.body.content.forEach(item => {
        if (item.paragraph) {
          item.paragraph.elements.forEach(el => {
            if (el.textRun) content += el.textRun.content;
          });
        }
      });
      return { content: [{ type: "text", text: content }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Docs Error: ${error.message}` }], isError: true };
    }
  }
);

/**
 * --- TOOL: READ SHEETS ---
 * Aggregated from 'xing5/mcp-google-sheets'
 */
server.tool(
  "read_spreadsheet",
  { 
    spreadsheetId: z.string().describe("The Spreadsheet ID"),
    range: z.string().describe("A1 notation range (e.g., 'Sheet1!A1:B10')") 
  },
  async ({ spreadsheetId, range }) => {
    try {
      const sheets = google.sheets({ version: 'v4', auth });
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      return { content: [{ type: "text", text: JSON.stringify(res.data.values, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Sheets Error: ${error.message}` }], isError: true };
    }
  }
);

/**
 * --- TOOL: SEARCH DRIVE ---
 * Aggregated from 'googleapis/genai-toolbox'
 */
server.tool(
  "search_drive",
  { query: z.string().describe("Search query, e.g., 'name contains \"Budget\"'") },
  async ({ query }) => {
    try {
      const drive = google.drive({ version: 'v3', auth });
      const res = await drive.files.list({ q: query, fields: 'files(id, name, mimeType)' });
      return { content: [{ type: "text", text: JSON.stringify(res.data.files, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Drive Error: ${error.message}` }], isError: true };
    }
  }
);

// 3. Express Infrastructure for Cloud Run (SSE Transport)
const app = express();
let transport;

// Endpoint for the initial connection
app.get("/sse", async (req, res) => {
  console.log("Master Agent: New SSE Connection Established");
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

// Endpoint for sending messages to the agent
app.post("/messages", async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No active session. Connect to /sse first.");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Master Agent online at http://0.0.0.0:${PORT}`);
});
