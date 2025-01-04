#!/bin/bash

# cdk deployment script

# Check if environment argument is provided
if [ -z "$1" ]; then
  echo "Please specify environment (dev or prod)"
  echo "Usage: ./deploy.sh dev|prod"
  exit 1
fi

STAGE=$1

# Check if jq is installed
if ! command -v jq &> /dev/null; then
  echo "Error: jq is not installed. Please install jq to parse JSON files"
  exit 1
fi

# Read configuration from JSON file
CONFIG_FILE="config/${STAGE}.json"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: Configuration file ${CONFIG_FILE} not found"
  exit 1
fi

# Extract values from JSON configuration
AWS_ACCOUNT_ID=$(jq -r '.awsAccountId' "$CONFIG_FILE")
AWS_WEBSITE_BUCKET_PREFIX=$(jq -r '.awsWebsiteBucketPrefix' "$CONFIG_FILE")
FRONTEND_REPO=$(jq -r '.frontendRepo' "$CONFIG_FILE")

# Check if .env file exists
if [ -f .env ]; then
  # Load environment variables
  export $(cat .env | xargs)
fi

# Validate required environment variables
if [ -z "$GITHUB_TOKEN" ]; then
  echo "Error: GITHUB_TOKEN not set"
  exit 1
fi

if [ -z "$RUNPODS_API_KEY" ]; then
  echo "Error: RUNPODS_API_KEY not set"
  exit 1
fi

if [ -z "$AWS_ACCESS_KEY_ID" ]; then
  echo "Error: AWS_ACCESS_KEY_ID not set"
  exit 1
fi

if [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
  echo "Error: AWS_SECRET_ACCESS_KEY not set"
  exit 1
fi

if [ -z "$AWS_REGION" ]; then
  echo "Error: AWS_REGION not set"
  exit 1
fi

# Validate values from JSON config
if [ -z "$AWS_ACCOUNT_ID" ]; then
  echo "Error: awsAccountId not found in config file"
  exit 1
fi

if [ -z "$AWS_WEBSITE_BUCKET_PREFIX" ]; then
  echo "Error: awsWebsiteBucketPrefix not found in config file"
  exit 1
fi

if [ -z "$FRONTEND_REPO" ]; then
  echo "Error: frontendRepo not found in config file"
  exit 1
fi

echo "Starting CDK deployment..."
echo "Deploying CDK infrastructure to AWS account ${AWS_ACCOUNT_ID} in region ${AWS_REGION} and stage ${STAGE}"

# Deploy the stack
if [ "$STAGE" = "prod" ]; then
    npx cdk deploy --context stage=${STAGE} --require-approval never
else
    npx cdk deploy --context stage=${STAGE}
fi

# Construct bucket name the same way as in CDK
BUCKET_NAME="${AWS_WEBSITE_BUCKET_PREFIX}-${AWS_ACCOUNT_ID}-${STAGE}"

echo "Building frontend and syncing frontend files to S3..."

# Create temporary directory
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

# Clone the frontend repository
echo "Cloning frontend repository..."
git clone --depth 1 https://${GITHUB_TOKEN}@github.com/${FRONTEND_REPO}.git "$TEMP_DIR/repo"
if [ $? -ne 0 ]; then
  echo "Error: Failed to clone repository"
  exit 1
fi

# Change to repo directory
cd "$TEMP_DIR/repo"

# Install dependencies and build
echo "Installing npm dependencies..."
if ! npm install; then
  echo "Error: Failed to install dependencies"
  exit 1
fi

echo "Running webpack build..."
if ! npm run webpack-build; then
  echo "Error: Failed to build frontend"
  exit 1
fi

# Verify dist directory exists and is not empty
if [ ! -d "dist" ] || [ -z "$(ls -A dist)" ]; then
  echo "Error: dist directory is missing or empty after build"
  exit 1
fi

# Check if the bucket exists
aws s3api head-bucket --bucket "${BUCKET_NAME}" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "Bucket exists, syncing files..."
  aws s3 sync dist/ "s3://${BUCKET_NAME}" --delete
else
  echo "Bucket doesn't exist yet, skipping sync"
fi

echo "CDK deployment and S3 sync succeeded for stage ${STAGE}"
