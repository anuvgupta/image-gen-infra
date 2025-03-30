// lambdas/get-upload-url-lambda.js

// Using AWS SDK v3
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { createPresignedPost } = require("@aws-sdk/s3-presigned-post");
// const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const ALLOWED_FILE_TYPES = ["image/png", "image/jpeg"]; // Only allow PNG and JPEG
const FIVE_MIB_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_FILE_SIZE = FIVE_MIB_BYTES;

const s3Client = new S3Client({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
    const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
    const getCorsHeaders = (allowedOrigin) => {
        return {
            "Access-Control-Allow-Origin": `${allowedOrigin}`,
            "Access-Control-Allow-Headers":
                "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,x-amz-content-sha256",
            "Access-Control-Allow-Methods": "POST,OPTIONS",
            "Access-Control-Allow-Credentials": "true",
        };
    };

    try {
        // Parse the request body
        const body = JSON.parse(event.body || "{}");
        const fileName = body.fileName;
        const fileType = body.fileType;

        // Validate required fields
        if (!fileName || !fileType) {
            return {
                statusCode: 400,
                headers: {
                    "Content-Type": "application/json",
                    ...getCorsHeaders(allowedOrigin),
                },
                body: JSON.stringify({
                    error: "fileName and fileType are required",
                }),
            };
        }
        // Validate file type
        if (!ALLOWED_FILE_TYPES.includes(fileType)) {
            return {
                statusCode: 400,
                headers: {
                    "Content-Type": "application/json",
                    ...getCorsHeaders(allowedOrigin),
                },
                body: JSON.stringify({
                    error: `Invalid file type. Allowed types: ${ALLOWED_FILE_TYPES.join(
                        ", "
                    )}`,
                }),
            };
        }

        // Create a unique file key with a folder structure
        const fileKey = `uploads/${Date.now()}-${fileName}`;

        // Set up pre-signed URL parameters
        const postParams = {
            Bucket: process.env.S3_BUCKET_NAME,
            Key: fileKey,
            Conditions: [
                ["content-length-range", 0, MAX_FILE_SIZE],
                ["eq", "$Content-Type", fileType],
            ],
            Fields: {
                "Content-Type": fileType,
            },
            Expires: 180, // 3 minutes
        };

        // Generate the pre-signed URL
        const { url, fields } = await createPresignedPost(s3Client, postParams);

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                ...getCorsHeaders(allowedOrigin),
            },
            body: JSON.stringify({
                url,
                fields,
                fileKey,
            }),
        };
    } catch (error) {
        console.error("Error generating pre-signed URL:", error);

        return {
            statusCode: 500,
            headers: {
                "Content-Type": "application/json",
                ...getCorsHeaders(allowedOrigin),
            },
            body: JSON.stringify({
                error: "Failed to generate upload URL",
                details: error.message,
            }),
        };
    }
};
