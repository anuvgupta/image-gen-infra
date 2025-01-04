#!/usr/bin/env bash

# cdk bootstrap script
set -e

# Check if environment argument is provided
if [ -z "$1" ]; then
  echo "Please specify environment (dev or prod)"
  echo "Usage: ./bootstrap.sh dev|prod"
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

# Check if .env file exists
if [ -f .env ]; then
  # Load environment variables
  export $(cat .env | xargs)
fi

# Check if required environment variables are set
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

# Bootstrap the account

echo "Bootstrapping AWS account ${AWS_ACCOUNT_ID} in region ${AWS_REGION} and stage ${STAGE}"

npx cdk bootstrap aws://${AWS_ACCOUNT_ID}/${AWS_REGION} --context stage=${STAGE} --tags for-use-with=cdk-deployments

echo "Successfully bootstrapped AWS account ${AWS_ACCOUNT_ID} in region ${AWS_REGION} and stage ${STAGE}"
