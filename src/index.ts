import "dotenv/config";
import { Agent } from "./agent";
import { CaptureUIScreenshotsResult } from "./types";

async function captureUIScreenshots(query: string, humanApprovalBeforeToolCalls: boolean = false): Promise<CaptureUIScreenshotsResult> {
    const agent = new Agent(process.env.MODEL_NAME!);
    return await agent.run(query, humanApprovalBeforeToolCalls ? ["playwrightToolNode", "playwrightToolNode2", "webSearchToolNode"] : undefined);
}


async function main(query: string, humanApprovalBeforeToolCalls: boolean = true) {
    const result = await captureUIScreenshots(query, humanApprovalBeforeToolCalls);
    console.log("\n===================\n    Final Result\n===================\n" + (result.success ? result.pathOfScreenshots : result.message));
    process.exit(0);
}

// If login is required to execute the below provided query, make sure to include the login credentials in the query itself
const query = `How to create a task with a due date in Asana?`;
const humanApprovalBeforeToolCalls = false;

main(query, humanApprovalBeforeToolCalls);