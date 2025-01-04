#!/usr/bin/env bash

# cdk deployment script
set -e

# Check if environment argument is provided
if [ -z "$1" ]; then
  echo "Please specify environment (dev or prod)"
  echo "Usage: ./deploy.sh dev|prod"
  exit 1
fi

export STAGE=$1

# Check if jq is installed
if ! command -v jq &> /dev/null; then
  echo "Error: jq is not installed. Please install jq to parse JSON files"
  exit 1
fi

# Read configuration from JSON file
export CONFIG_FILE="config/${STAGE}.json"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: Configuration file ${CONFIG_FILE} not found"
  exit 1
fi

# Extract values from JSON configuration
export AWS_ACCOUNT_ID=$(jq -r '.awsAccountId' "$CONFIG_FILE")
export AWS_WEBSITE_BUCKET_PREFIX=$(jq -r '.awsWebsiteBucketPrefix' "$CONFIG_FILE")
export FRONTEND_REPO=$(jq -r '.frontendRepo' "$CONFIG_FILE")

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

if [ "$STAGE" = "prod" ]; then
  if [ -z "$RUNPODS_API_KEY_PROD" ]; then
    echo "Error: RUNPODS_API_KEY_PROD not set"
    exit 1
  fi
else
  if [ -z "$RUNPODS_API_KEY_DEV" ]; then
      echo "Error: RUNPODS_API_KEY_DEV not set"
      exit 1
  fi
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
npx cdk deploy "--context" "stage=$STAGE" "--require-approval" "never" "--outputs-file" "cdk-outputs.json"

# Extract CloudFront distribution ID from outputs
export CLOUDFRONT_DISTRIBUTION_ID=$(jq -r ".[\"image-gen-${STAGE}\"].CloudFrontDistributionId" "cdk-outputs.json")

./s3-sync.sh

echo "CDK deployment and S3 sync succeeded for stage ${STAGE}"
