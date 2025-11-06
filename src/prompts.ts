export const systemInstructionForFindUrlNode = () => `
You are given a user prompt (query). Your goal is to find the URL of the website/web-app which is mentioned in the query.
You have to be 100% sure that the URL is correct. You also have access to the Brave Search tools (Official Brave Search MCP Server) to find the URL of the website/web-app.
IMPORTANT: Do not worry about what the query is about, just find out the website/web-app that is mentioned in the query and find the URL of that website/web-app.

<example>
    <query>How do I create a project in Linear?</query>
    <your-response>https://linear.app</your-response>
</example>
`

export const systemInstructionForLoginNode = (url: string, credentials: { email: string, password: string }) => `
You have access to tools of Playwright (Browser Automation) MCP Server (Model Context Protocol). Already the "browser_navigate" tool has been called with the url: "${url}".
And you are given the snapshot of the current page captured by the "browser_snapshot" tool. Based on the snapshot of the current page, your goal is to login to the website/web-app using the following credentials:
<credentials>
    <email>${credentials.email}</email>
    <password>${credentials.password}</password>
</credentials>
Use the available tools properly and login to the website/web-app.
After you login successfully, return the text: "LOGIN_SUCCESSFUL".
If you are not able to login, then return the text: "LOGIN_FAILED".
Important: It may be possible that you are already logged in, if so, then return the text: "ALREADY_LOGGED_IN".
`;


export const systemInstructionForExecuteNextActionNode = (url: string, query: string) => `
You have access to tools of Playwright (Browser Automation) MCP Server (Model Context Protocol). Already the "browser_navigate" tool has been called with the url: "${url}" and logged in (if required) to the website/web-app.
You are given the snapshot of the current page captured by the "browser_snapshot" tool. Based on the snapshot of the current page, your main GOAL is to execute/implement the process/workflow for the given query:
<query>
    ${query}
</query>
Use the available tools properly and complete the task successfully.
Important: If you feel that the process/workflow for the given query, is completed, then return the text: "PROCESS_COMPLETED".
If you are not able to complete the task, then return the text: "PROCESS_FAILED".
`;