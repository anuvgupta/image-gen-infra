// bin/image-gen-infra.ts
import * as cdk from "aws-cdk-lib";
import * as fs from "fs";
import * as path from "path";

import { ImageGenStack } from "../lib/image-gen-stack";

const app = new cdk.App();

// Validate environment variables
const requiredEnvVars = ["RUNPODS_API_KEY"];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        throw new Error(`Missing required environment variable: ${envVar}`);
    }
}

// Load environment config
const stage = app.node.tryGetContext("stage");
if (!stage) {
    throw new Error("Please specify config using --context stage=dev|prod");
}

const configPath = path.join(__dirname, `../../config/${stage}.json`);
if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// Create the stack
new ImageGenStack(app, `ImageGen-${stage}`, {
    ...config,
    // Securely pass sensitive values from environment variables
    runpodsApiKey: process.env.RUNPODS_API_KEY!,
    devWebsiteUsername: process.env.DEV_WEBSITE_USERNAME!,
    devWebsitePassword: process.env.DEV_WEBSITE_PASSWORD!,
    stageName: stage,
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    },
    stackName: `${config.stackNamePrefix}-${stage}`,
    tags: config.tags,
});

app.synth();
