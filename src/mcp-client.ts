import "dotenv/config"
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class MCPClient {
    private mcp: Client;
    private transport: StreamableHTTPClientTransport | null = null;
    private stdioTransport: StdioClientTransport | null = null;
    private tools: any[] = [];

    constructor() {
        this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
    }

    async connectToServer(url: string, token?: string) {
        try {
            this.transport = new StreamableHTTPClientTransport(new URL(url), {
                requestInit: {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                }
            });
            await this.mcp.connect(this.transport);
            const toolsResult = await this.mcp.listTools();
            this.tools = toolsResult.tools.map((tool) => {
                return {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema
                };
            });
            // console.log(
            //     "Connected to server with tools:",
            //     this.tools.map(({ name }) => name)
            // );
        } catch (e) {
            console.log("Failed to connect to MCP server: ", e);
            throw e;
        }
    }

    async connectToLocalServer(command: string, args: string[], env?: Record<string, string>) {
        try {
            this.stdioTransport = new StdioClientTransport({ command, args, env });
            await this.mcp.connect(this.stdioTransport);
            const toolsResult = await this.mcp.listTools();
            this.tools = toolsResult.tools.map((tool) => {
                return {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema
                };
            });
            // console.log(
            //     "Connected to server with tools:",
            //     this.tools.map(({ name }) => name)
            // );
        } catch (e) {
            console.log("Failed to connect to MCP server: ", e);
            throw e;
        }
    }

    getMCPTools() {
        return this.tools;
    }

    async callTool(toolName: string, args: any) {
        return await this.mcp.callTool({ name: toolName, arguments: args });
    }

    async disconnect() {
        await this.mcp.close();
    }
}