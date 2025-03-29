# #!/usr/bin/env bash

# s3 bucket sync script
set -e

# Validate bucket info is set
if [ -z "$STAGE" ]; then
  echo "Error: STAGE not set"
  exit 1
fi
if [ -z "$AWS_ACCOUNT_ID" ]; then
  echo "Error: AWS_ACCOUNT_ID not set"
  exit 1
fi
if [ -z "$AWS_WEBSITE_BUCKET_PREFIX" ]; then
  echo "Error: AWS_WEBSITE_BUCKET_PREFIX not set"
  exit 1
fi
# Validate CloudFront distribution ID is set
if [ -z "$CLOUDFRONT_DISTRIBUTION_ID" ]; then
  echo "Error: CLOUDFRONT_DISTRIBUTION_ID not set"
  exit 1
fi

# Construct bucket name the same way as in CDK
BUCKET_NAME="${AWS_WEBSITE_BUCKET_PREFIX}-${AWS_ACCOUNT_ID}-${STAGE}"

echo "Building frontend and syncing frontend files to S3..."

# Create temporary directory
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

# Clone the frontend repository
BRANCH=$([ "$STAGE" = "dev" ] && echo "main" || echo "prod")
echo "Cloning frontend repository, branch ${BRANCH}..."
git clone --depth 1 -b $BRANCH https://${GITHUB_TOKEN}@github.com/${FRONTEND_REPO}.git "$TEMP_DIR/repo"
if [ $? -ne 0 ]; then
  echo "Error: Failed to clone repository"
  exit 1
fi

# Change to repo directory
cd "$TEMP_DIR/repo"

# Get the current commit hash
CURRENT_COMMIT=$(git rev-parse HEAD)
echo "Current commit hash: ${CURRENT_COMMIT}"

# Try to get the last deployed commit from S3 bucket tags
LAST_DEPLOYED_COMMIT=""
if aws s3api head-bucket --bucket "${BUCKET_NAME}" 2>/dev/null; then
  echo "Checking last deployed commit hash..."
  LAST_DEPLOYED_COMMIT=$(aws s3api get-bucket-tagging --bucket "${BUCKET_NAME}" 2>/dev/null | jq -r '.TagSet[] | select(.Key=="LastDeployedCommit") | .Value' || echo "")
fi

echo "Last deployed commit hash: ${LAST_DEPLOYED_COMMIT}"

if [ "$CURRENT_COMMIT" = "$LAST_DEPLOYED_COMMIT" ]; then
  echo "No changes detected in frontend repository. Skipping frontend deployment."
  exit 0
fi

echo "Changes detected, syncing S3 with frontend repo"

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
if aws s3api head-bucket --bucket "${BUCKET_NAME}" 2>/dev/null; then
  echo "Bucket exists, syncing files..."
  
  # Sync files to S3
  aws s3 sync dist/ "s3://${BUCKET_NAME}" --delete
  
  # Update the commit hash tag
  # First, try to get existing tags to preserve them
  EXISTING_TAGS=$(aws s3api get-bucket-tagging --bucket "${BUCKET_NAME}" 2>/dev/null || echo '{"TagSet": []}')
  
  # Create new tags JSON, preserving existing tags except LastDeployedCommit
  NEW_TAGS=$(echo "$EXISTING_TAGS" | jq --arg commit "$CURRENT_COMMIT" '
    .TagSet = ([.TagSet[] | select(.Key != "LastDeployedCommit")] + [{
      Key: "LastDeployedCommit",
      Value: $commit
    }])
  ')
  
  # Apply the new tags
  echo "$NEW_TAGS" | aws s3api put-bucket-tagging --bucket "${BUCKET_NAME}" --tagging file:///dev/stdin
  
  echo "Successfully updated S3 bucket and commit hash tag"

  # Create CloudFront invalidation and wait for completion
  echo "Creating CloudFront cache invalidation for distribution ${CLOUDFRONT_DISTRIBUTION_ID}"
  INVALIDATION_ID=$(aws cloudfront create-invalidation \
      --distribution-id "${CLOUDFRONT_DISTRIBUTION_ID}" \
      --paths "/*" \
      --query 'Invalidation.Id' \
      --output text)

  echo "Waiting for invalidation ${INVALIDATION_ID} to complete..."
  aws cloudfront wait invalidation-completed \
      --distribution-id "${CLOUDFRONT_DISTRIBUTION_ID}" \
      --id "${INVALIDATION_ID}"

  echo "Successfully completed CloudFront invalidation"
else
  echo "Bucket doesn't exist yet, skipping sync"
fi
