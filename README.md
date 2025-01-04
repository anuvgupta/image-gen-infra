# image gen infra as cdk code

Infrastructure for image generation workers & frontend

## cdk setup guide

-   in AWS console, create an IAM policy for CDK deployments, add the contents of `cdk-policy.json` from this repo, save the policy
-   in AWS console, create an IAM user, add the policy just created, create and download an access + secret key pair
-   in local repo, add env vars for the following for dev:

    ```
    GITHUB_TOKEN="..."
    RUNPODS_API_KEY_DEV="..."
    RUNPODS_API_KEY_PROD=""
    AWS_ACCESS_KEY_ID="..."
    AWS_SECRET_ACCESS_KEY="..."
    AWS_REGION="us-east-1"
    DEV_WEBSITE_USERNAME="..."
    DEV_WEBSITE_PASSWORD="..."
    ```

-   in local repo, modify `config/dev.json` and `config.prod.json` with your settings for dev & prod. Make sure to update fields `domainName`, `apiDomainName`, `runpodsEndpoint`, `awsAccountId`, `frontendRepo`
-   in local repo, install `jq` CLI program via apt or brew
-   in local repo, build with `npm run build`
-   in local repo, bootstrap the aws account with `npm run bootstrap:dev`
-   in local repo, deploy with `npm run deploy:dev`

## auto generated cdk readme

### Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

### Useful commands

-   `npm run build` compile typescript to js
-   `npm run watch` watch for changes and compile
-   `npm run test` perform the jest unit tests
-   `npx cdk deploy` deploy this stack to your default AWS account/region
-   `npx cdk diff` compare deployed stack with current state
-   `npx cdk synth` emits the synthesized CloudFormation template
