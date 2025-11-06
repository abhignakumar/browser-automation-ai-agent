import readline from 'readline';
import { FunctionCall } from "@google/genai";
import fs from "fs";
import path from "path";

export function inputFromUserTerminal(question: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

export async function getHumanApproval(functionCalls: FunctionCall[]): Promise<"Allow" | "Reject"> {
    const answer = await inputFromUserTerminal(`Approve function calls ${functionCalls.map((fc) => `"${fc.name}" with args ${JSON.stringify(fc.args)}`).join(",\n")}? (yes/no): `);
    return answer.trim().toLowerCase() === "yes" ? "Allow" : "Reject";
}

export function copyDirectorySync(source: string, destination: string) {
    if (!fs.existsSync(destination))
        fs.mkdirSync(destination, { recursive: true });
    const files = fs.readdirSync(source);
    for (const file of files) {
        const srcPath = path.join(source, file);
        const destPath = path.join(destination, file);
        const stat = fs.statSync(srcPath);
        if (stat.isDirectory())
            copyDirectorySync(srcPath, destPath);
        else
            fs.copyFileSync(srcPath, destPath);
    }
}