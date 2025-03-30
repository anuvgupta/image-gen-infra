// lambdas/get-upload-url-lambda.js

// Using AWS SDK v3
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3Client = new S3Client({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
    try {
        // Parse the request body
        const body = JSON.parse(event.body || "{}");
        const fileName = body.fileName;
        const fileType = body.fileType;

        if (!fileName || !fileType) {
            return {
                statusCode: 400,
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    error: "fileName and fileType are required",
                }),
            };
        }

        // Create a unique file key with a folder structure
        const fileKey = `uploads/${Date.now()}-${fileName}`;

        // Set up pre-signed URL parameters
        const putObjectParams = {
            Bucket: process.env.S3_BUCKET_NAME,
            Key: fileKey,
            ContentType: fileType,
        };

        // Create the command
        const command = new PutObjectCommand(putObjectParams);

        // Generate the pre-signed URL
        const uploadURL = await getSignedUrl(s3Client, command, {
            expiresIn: 300,
        }); // URL expires in 5 minutes

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                uploadURL: uploadURL,
                fileKey: fileKey,
            }),
        };
    } catch (error) {
        console.error("Error generating pre-signed URL:", error);

        return {
            statusCode: 500,
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                error: "Failed to generate upload URL",
                details: error.message,
            }),
        };
    }
};
