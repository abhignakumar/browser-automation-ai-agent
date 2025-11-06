import "dotenv/config";
import { Content, FunctionCall, GoogleGenAI } from "@google/genai";
import { MCPClient } from "./mcp-client";
import { getHumanApproval, copyDirectorySync } from "./utils";
import { systemInstructionForExecuteNextActionNode, systemInstructionForLoginNode, systemInstructionForFindUrlNode } from "./prompts";
import { CaptureUIScreenshotsResult, AuthState, State } from "./types";
import fs from "fs";

class AgentState {
    userPrompt: State<string> = { data: "" }
    auth: State<AuthState | null> = { data: null }
    url: State<string | null> = { data: null }
    query: State<string | null> = { data: null }

    findUrlNodeMessages: State<Content[]> = { data: [], reducer: (cur: Content[], update: Content[]) => { return [...cur, ...update] } }
    loginNodeMessages: State<Content[]> = { data: [], reducer: (cur: Content[], update: Content[]) => { return [...cur, ...update] } }
    executeNextActionNodeMessages: State<Content[]> = { data: [], reducer: (cur: Content[], update: Content[]) => { return [...cur, ...update] } }
}

type ReturnState = {
    [key in keyof AgentState]?: AgentState[key] extends State<infer U> ? U : never;
}

export class Agent {
    agentState: AgentState;
    geminiModel: GoogleGenAI;
    modelName: string;
    mcpClient: MCPClient;
    webSearchMcpClient: MCPClient;

    nameNodeMapper: Record<string, Function> = {
        START: () => this.START(),
        relevancyAndAuthNode: () => this.relevancyAndAuthNode(),
        findUrlNode: () => this.findUrlNode(),
        loginNode: () => this.loginNode(),
        executeNextActionNode: () => this.executeNextActionNode(),
        playwrightToolNode: () => this.playwrightToolNode(),
        playwrightToolNode2: () => this.playwrightToolNode2(),
        webSearchToolNode: () => this.webSearchToolNode(),
    }
    edges: Record<string, () => string> = {
        START: () => "relevancyAndAuthNode",
        relevancyAndAuthNode: () => "findUrlNode",
        findUrlNode: () => this.findUrlNodeOutputEdge(),
        webSearchToolNode: () => "findUrlNode",
        loginNode: () => this.loginNodeOutputEdge(),
        playwrightToolNode: () => "loginNode",
        executeNextActionNode: () => this.executeNextActionNodeOutputEdge(),
        playwrightToolNode2: () => "executeNextActionNode",
    }

    constructor(modelName: string) {
        this.geminiModel = new GoogleGenAI({});
        this.mcpClient = new MCPClient();
        this.webSearchMcpClient = new MCPClient();
        this.agentState = new AgentState();
        this.modelName = modelName;
    }

    async connectToMCPServers() {
        await this.mcpClient.connectToLocalServer("npx", [
            "@playwright/mcp@latest",
        ])
        await this.webSearchMcpClient.connectToLocalServer("npx",
            ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
            {
                "BRAVE_API_KEY": process.env.BRAVE_API_KEY!
            }
        )
    }

    // ***** NODES *****

    // Start Node
    async START(): Promise<ReturnState> {
        return {}
    }

    // Relevancy and Auth Node
    async relevancyAndAuthNode(): Promise<ReturnState> {
        const response = await this.geminiModel.models.generateContent({
            model: this.modelName,
            contents: [{ role: "user", parts: [{ text: this.agentState.userPrompt.data }] }],
            config: {
                responseMimeType: "application/json",
                responseJsonSchema: {
                    type: "object",
                    properties: {
                        isRelevant: { type: "boolean" },
                        message: { type: "string" },
                    },
                    required: ["isRelevant"],
                },
                systemInstruction: `You are given a user prompt (query). Is the query relevant to a website/web-app AND a process/workflow in that website/web-app? Only give message if the query is NOT relevant.`,
            }
        });
        if (!response.candidates || response.candidates.length === 0)
            throw new Error("Model did not return any response while checking if the query is relevant or not.");
        console.log("\n======Relevancy and Auth Node - 1======\n");
        console.log(JSON.stringify(response.candidates[0].content, null, 2));
        console.log("\n===================================\n");
        let responseJson: { isRelevant: boolean, message?: string };
        try {
            responseJson = JSON.parse(response.candidates[0].content?.parts?.[0].text || "{}");
        } catch (error) {
            throw new Error("Model did not return a valid JSON response while checking if the query is relevant or not.");
        }
        if (!responseJson.isRelevant)
            throw new Error(responseJson.message || "Query is not relevant to a website/web-app AND a process/workflow in that website/web-app.");

        const response2 = await this.geminiModel.models.generateContent({
            model: this.modelName,
            contents: [{ role: "user", parts: [{ text: this.agentState.userPrompt.data }] }],
            config: {
                responseMimeType: "application/json",
                responseJsonSchema: {
                    type: "object",
                    properties: {
                        isAuthRequired: { type: "boolean" },
                        credentials: { type: "object", properties: { email: { type: "string" }, password: { type: "string" } }, required: ["email", "password"] },
                        query: { type: "string" },
                    },
                    required: ["isAuthRequired", "query"],
                },
                systemInstruction: `You are given a user prompt (query). According to best of your knowledge, tell if authentication is required to execute the process/workflow for the given query? And also extract the query and credentials (if given) from the user prompt (query).`,
            }
        });
        if (!response2.candidates || response2.candidates.length === 0)
            throw new Error("Model did not return any response while checking if the query is relevant or not.");
        console.log("\n======Relevancy and Auth Node - 2======\n");
        console.log(JSON.stringify(response2.candidates[0].content, null, 2));
        console.log("\n===================================\n");
        let responseJson2: { isAuthRequired: boolean, credentials?: { email: string, password: string }, query: string };
        try {
            responseJson2 = JSON.parse(response2.candidates[0].content?.parts?.[0].text || "{}");
        } catch (error) {
            throw new Error("Model did not return a valid JSON response while checking if the query is relevant or not.");
        }
        if (responseJson2.isAuthRequired && (!responseJson2.credentials || responseJson2.credentials.email.trim() === "" || responseJson2.credentials.password.trim() === ""))
            throw new Error("Authentication is required to execute the process/workflow for the given query, but credentials are not present in the query.");

        this.agentState.findUrlNodeMessages.data.push({ role: "user", parts: [{ text: responseJson2.query }] });
        if (responseJson2.isAuthRequired && responseJson2.credentials)
            return { auth: { isRequired: true, credentials: responseJson2.credentials }, query: responseJson2.query };
        return { auth: { isRequired: false }, query: responseJson2.query };
    }

    // Find URL Node
    async findUrlNode(): Promise<ReturnState> {
        const response = await this.geminiModel.models.generateContent({
            model: this.modelName,
            contents: this.agentState.findUrlNodeMessages.data,
            config: {
                tools: [
                    {
                        functionDeclarations: this.webSearchMcpClient.getMCPTools()
                    }
                ],
                systemInstruction: systemInstructionForFindUrlNode(),
            }
        });
        if (!response.candidates || response.candidates.length === 0 || !response.candidates[0].content)
            throw new Error("Model did not return any response while finding the URL.");
        this.agentState.findUrlNodeMessages.data.push(response.candidates[0].content);
        console.log("\n======Find URL Node======\n");
        console.log(JSON.stringify(response.candidates[0].content, null, 2));
        console.log("\n===================================\n");

        if (response.candidates[0].content.parts && response.candidates[0].content.parts.length > 0 && response.candidates[0].content.parts.filter(p => p.functionCall).length > 0)
            return {}
        else {
            if (!response.candidates[0].content.parts?.[0].text?.trim().startsWith("http://") && !response.candidates[0].content.parts?.[0].text?.trim().startsWith("https://") && !response.candidates[0].content.parts?.[0].text?.trim().startsWith("www."))
                throw new Error("Model did not find and return a valid URL for the website/web-app of the given query.");
            try {
                this.mcpClient.callTool("browser_navigate", { url: response.candidates[0].content.parts?.[0].text?.trim() });
            } catch (error) {
                throw new Error("Failed to navigate to the URL using the browser_navigate tool.");
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
            const snapshotToolResponse = await this.mcpClient.callTool("browser_snapshot", {});
            this.agentState.loginNodeMessages.data.push({ role: "user", parts: [{ text: "Current page snapshot: \n" + JSON.stringify(snapshotToolResponse.content) }] });
            return { url: response.candidates[0].content.parts?.[0].text?.trim() };
        }
    }

    // Web Search Tool Node
    async webSearchToolNode(): Promise<ReturnState> {
        const noToolCallMessage: Content = { role: "user", parts: [{ text: "Last message is not a tool call." }] };
        const lastMessage = this.agentState.findUrlNodeMessages.data.length === 0 ? undefined : this.agentState.findUrlNodeMessages.data[this.agentState.findUrlNodeMessages.data.length - 1];
        if (!lastMessage || (lastMessage.role && lastMessage.role !== "model")) {
            return { findUrlNodeMessages: [noToolCallMessage] };
        }
        if (!lastMessage.parts || lastMessage.parts.length === 0 || lastMessage.parts.filter(p => p.functionCall).length === 0) {
            return { findUrlNodeMessages: [noToolCallMessage] };
        }
        let message: Content = { role: "user", parts: [] };
        for (const part of lastMessage.parts.filter(p => p.functionCall)) {
            const functionCall = part.functionCall;
            if (functionCall?.name && functionCall?.args) {
                const result = await this.webSearchMcpClient.callTool(functionCall.name, functionCall.args);
                let resultContent = result.content as any;
                if (Array.isArray(resultContent))
                    resultContent = resultContent.filter((r: any) => Object.keys(r).includes("type") && r.type !== "image");
                const responseObj = { functionResponse: { id: functionCall.id, name: functionCall.name, response: { output: resultContent } } };
                message.parts?.push(responseObj);
            }
        }
        for (const part of message.parts || []) {
            if (part.text)
                console.log("\n" + part.text + "\n");
            if (part.functionResponse)
                console.log("\n" + JSON.stringify(part.functionResponse, null, 2) + "\n");
        }
        if (message.parts?.length && message.parts.length > 0)
            return { findUrlNodeMessages: [message] };
        return { findUrlNodeMessages: [noToolCallMessage] };
    }

    // Login Node
    async loginNode(): Promise<ReturnState> {
        const response = await this.geminiModel.models.generateContent({
            model: this.modelName,
            contents: this.agentState.loginNodeMessages.data,
            config: {
                systemInstruction: systemInstructionForLoginNode(this.agentState.url.data || "", this.agentState.auth.data!.isRequired ? this.agentState.auth.data!.credentials : { email: "", password: "" }),
                tools: [
                    {
                        functionDeclarations: this.mcpClient.getMCPTools()
                    }
                ],
            }
        });
        const responseContent = response.candidates && response.candidates[0].content;
        for (const part of responseContent?.parts || []) {
            if (part.text)
                console.log("\n" + part.text + "\n");
            if (part.functionCall)
                console.log("\n" + JSON.stringify(part.functionCall, null, 2) + "\n");
        }
        return { loginNodeMessages: responseContent ? [responseContent] : undefined }
    }

    // Playwright Tool Node
    async playwrightToolNode(): Promise<ReturnState> {
        const noToolCallMessage: Content = { role: "user", parts: [{ text: "Last message is not a tool call." }] };
        const lastMessage = this.agentState.loginNodeMessages.data.length === 0 ? undefined : this.agentState.loginNodeMessages.data[this.agentState.loginNodeMessages.data.length - 1];
        if (!lastMessage || (lastMessage.role && lastMessage.role !== "model")) {
            return { loginNodeMessages: [noToolCallMessage] };
        }
        if (!lastMessage.parts || lastMessage.parts.length === 0 || lastMessage.parts.filter(p => p.functionCall).length === 0) {
            return { loginNodeMessages: [noToolCallMessage] };
        }
        let message: Content = { role: "user", parts: [] };
        for (const part of lastMessage.parts.filter(p => p.functionCall)) {
            const functionCall = part.functionCall;
            if (functionCall?.name && functionCall?.args) {
                const result = await this.mcpClient.callTool(functionCall.name, functionCall.args);
                let resultContent = result.content as any;
                if (Array.isArray(resultContent))
                    resultContent = resultContent.filter((r: any) => Object.keys(r).includes("type") && r.type !== "image");
                const responseObj = { functionResponse: { id: functionCall.id, name: functionCall.name, response: { output: resultContent } } };
                message.parts?.push(responseObj);
            }
        }
        for (const part of message.parts || []) {
            if (part.text)
                console.log("\n" + part.text + "\n");
            if (part.functionResponse)
                console.log("\n" + JSON.stringify(part.functionResponse, null, 2) + "\n");
        }
        if (message.parts?.length && message.parts.length > 0)
            return { loginNodeMessages: [message] };
        return { loginNodeMessages: [noToolCallMessage] };
    }

    // Execute Next Action Node
    async executeNextActionNode(): Promise<ReturnState> {
        if (this.agentState.executeNextActionNodeMessages.data.length === 0) {
            const snapshotToolResponse = await this.mcpClient.callTool("browser_snapshot", {});
            this.agentState.executeNextActionNodeMessages.data.push({ role: "user", parts: [{ text: "Current page snapshot: \n" + JSON.stringify(snapshotToolResponse.content) }] });
        }
        const response = await this.geminiModel.models.generateContent({
            model: this.modelName,
            contents: this.agentState.executeNextActionNodeMessages.data,
            config: {
                systemInstruction: systemInstructionForExecuteNextActionNode(this.agentState.url.data || "", this.agentState.query.data || ""),
                tools: [
                    {
                        functionDeclarations: this.mcpClient.getMCPTools()
                    }
                ],
            }
        });
        const responseContent = response.candidates && response.candidates[0].content;
        for (const part of responseContent?.parts || []) {
            if (part.text)
                console.log("\n" + part.text + "\n");
            if (part.functionCall)
                console.log("\n" + JSON.stringify(part.functionCall, null, 2) + "\n");
        }
        if (!(responseContent?.parts?.length && responseContent?.parts?.length > 0 && responseContent?.parts?.filter(p => p.functionCall).length > 0)) {
            if (responseContent?.parts?.[0].text?.includes("PROCESS_FAILED"))
                throw new Error(responseContent?.parts?.[0].text || "Process not completed and no function/tool call returned. Model output: \n" + JSON.stringify(responseContent?.parts, null, 2) + "\n");
        }
        await this.mcpClient.callTool("browser_take_screenshot", {});
        return { executeNextActionNodeMessages: responseContent ? [responseContent] : undefined }
    }

    // Playwright Tool Node 2
    async playwrightToolNode2(): Promise<ReturnState> {
        const noToolCallMessage: Content = { role: "user", parts: [{ text: "Last message is not a tool call." }] };
        const lastMessage = this.agentState.executeNextActionNodeMessages.data.length === 0 ? undefined : this.agentState.executeNextActionNodeMessages.data[this.agentState.executeNextActionNodeMessages.data.length - 1];
        if (!lastMessage || (lastMessage.role && lastMessage.role !== "model")) {
            return { executeNextActionNodeMessages: [noToolCallMessage] };
        }
        if (!lastMessage.parts || lastMessage.parts.length === 0 || lastMessage.parts.filter(p => p.functionCall).length === 0) {
            return { executeNextActionNodeMessages: [noToolCallMessage] };
        }
        let message: Content = { role: "user", parts: [] };
        for (const part of lastMessage.parts.filter(p => p.functionCall)) {
            const functionCall = part.functionCall;
            if (functionCall?.name && functionCall?.args) {
                const result = await this.mcpClient.callTool(functionCall.name, functionCall.args);
                let resultContent = result.content as any;
                if (Array.isArray(resultContent))
                    resultContent = resultContent.filter((r: any) => Object.keys(r).includes("type") && r.type !== "image");
                const responseObj = { functionResponse: { id: functionCall.id, name: functionCall.name, response: { output: resultContent } } };
                message.parts?.push(responseObj);
            }
        }
        for (const part of message.parts || []) {
            if (part.text)
                console.log("\n" + part.text + "\n");
            if (part.functionResponse)
                console.log("\n" + JSON.stringify(part.functionResponse, null, 2) + "\n");
        }
        if (message.parts?.length && message.parts.length > 0)
            return { executeNextActionNodeMessages: [message] };
        return { executeNextActionNodeMessages: [noToolCallMessage] };
    }

    // ***** EDGES *****

    // Find URL Node Output Edge
    findUrlNodeOutputEdge(): "webSearchToolNode" | "loginNode" | "executeNextActionNode" {
        const lastMessage = this.agentState.findUrlNodeMessages.data[this.agentState.findUrlNodeMessages.data.length - 1];
        if (lastMessage.parts?.length && lastMessage.parts.length > 0 && lastMessage.parts.filter(p => p.functionCall).length > 0)
            return "webSearchToolNode";
        else {
            if (!this.agentState.auth.data)
                throw new Error("Auth state is not initialized.");
            if (this.agentState.auth.data.isRequired)
                return "loginNode";
            return "executeNextActionNode";
        }
    }

    // Login Node Output Edge
    loginNodeOutputEdge(): "executeNextActionNode" | "playwrightToolNode" {
        const lastMessage = this.agentState.loginNodeMessages.data[this.agentState.loginNodeMessages.data.length - 1];
        if (lastMessage.parts?.length && lastMessage.parts.length > 0 && lastMessage.parts.filter(p => p.functionCall).length > 0)
            return "playwrightToolNode";
        if (lastMessage.parts?.length && lastMessage.parts.length > 0) {
            if (lastMessage.parts[0].text?.includes("LOGIN_FAILED"))
                throw new Error("Login failed.");
            else if (lastMessage.parts[0].text?.includes("LOGIN_SUCCESSFUL") || lastMessage.parts[0].text?.includes("ALREADY_LOGGED_IN"))
                return "executeNextActionNode";
            else
                throw new Error(lastMessage.parts[0].text || "Login failed.");
        }
        throw new Error("Login failed. Something went wrong.");
    }

    // Execute Next Action Node Output Edge
    executeNextActionNodeOutputEdge(): "playwrightToolNode2" | "END" {
        const lastMessage = this.agentState.executeNextActionNodeMessages.data[this.agentState.executeNextActionNodeMessages.data.length - 1];
        if (lastMessage.parts?.length && lastMessage.parts.length > 0 && lastMessage.parts.filter(p => p.functionCall).length > 0)
            return "playwrightToolNode2";
        if (lastMessage.parts?.length && lastMessage.parts.length > 0 && lastMessage.parts[0].text?.includes("PROCESS_COMPLETED"))
            return "END";
        throw new Error(lastMessage.parts?.[0].text || "Failed to complete the process.");
    }

    async run(userPrompt: string, humanApprovalBefore?: string[]): Promise<CaptureUIScreenshotsResult> {
        this.agentState.userPrompt.data = userPrompt;
        await this.connectToMCPServers();
        let currentNode: string = "START";
        while (currentNode !== "END") {
            if (humanApprovalBefore && humanApprovalBefore.includes(currentNode)) {
                let functionCalls: FunctionCall[] = [];
                if (currentNode === "webSearchToolNode")
                    functionCalls = this.agentState.findUrlNodeMessages.data[this.agentState.findUrlNodeMessages.data.length - 1].parts?.filter(p => p.functionCall)!.map(p => p.functionCall!)!;
                else if (currentNode === "playwrightToolNode")
                    functionCalls = this.agentState.loginNodeMessages.data[this.agentState.loginNodeMessages.data.length - 1].parts?.filter(p => p.functionCall)!.map(p => p.functionCall!)!;
                else
                    functionCalls = this.agentState.executeNextActionNodeMessages.data[this.agentState.executeNextActionNodeMessages.data.length - 1].parts?.filter(p => p.functionCall)!.map(p => p.functionCall!)!;
                const approval = await getHumanApproval(functionCalls);
                if (approval === "Reject") {
                    console.log("Function call (Tool call) Rejected.");
                    await this.mcpClient.disconnect();
                    await this.webSearchMcpClient.disconnect();
                    return { success: false, message: "Function call (Tool call) Rejected." };
                }
            }
            let result: ReturnState;
            try {
                result = await this.nameNodeMapper[currentNode]() as ReturnState;
            } catch (error: any) {
                console.log("\n=====In Run Function=====\n" + error + "\n=====In Run Function - END=====\n");
                await this.mcpClient.disconnect();
                await this.webSearchMcpClient.disconnect();
                return { success: false, message: error.message };
            }

            Object.entries(result).forEach(([key, value]) => {
                const stateKey = key as keyof AgentState;
                if (this.agentState[stateKey]) {
                    if (this.agentState[stateKey].reducer) {
                        const reducerFunc = this.agentState[stateKey].reducer as (cur: typeof value, update: typeof value) => typeof value;
                        this.agentState[stateKey].data = reducerFunc(this.agentState[stateKey].data, value);
                    } else {
                        this.agentState[stateKey].data = value;
                    }
                }
            });
            currentNode = this.edges[currentNode]();
        }
        await this.mcpClient.disconnect();
        await this.webSearchMcpClient.disconnect();
        const folderName = `task-${new Date().getTime()}`;
        const latestFolder = fs.readdirSync(process.env.PLAYWRIGHT_MCP_OUTPUT_DIR!).sort((a, b) => fs.statSync(`${process.env.PLAYWRIGHT_MCP_OUTPUT_DIR}/${b}`).mtime.getTime() - fs.statSync(`${process.env.PLAYWRIGHT_MCP_OUTPUT_DIR}/${a}`).mtime.getTime())[0];
        copyDirectorySync(`${process.env.PLAYWRIGHT_MCP_OUTPUT_DIR}/${latestFolder}`, `${process.env.SCREENSHOT_DIR}/${folderName}`);

        return { success: true, pathOfScreenshots: `${process.env.SCREENSHOT_DIR}/${folderName}` };
    }
}