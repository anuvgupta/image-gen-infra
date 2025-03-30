// image-gen.stack.ts

import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

import { Construct } from "constructs";

import { calculateTPS, TPSCalculationParams } from "../util/tps";

const FIVE_MIB_BYTES = 5242880;
const ALLOWED_UPLOAD_TYPES = ["image/png", "image/jpeg"];
const ALLOWED_FILE_EXTENSIONS = "png|jpg|jpeg";

interface ImageGenStackProps extends cdk.StackProps {
    stageName: string;
    domainName: string;
    apiDomainName: string;
    runpodsApiKey: string;
    runpodsEndpoint: string;
    awsOutputBucketPrefix: string;
    awsInputBucketPrefix: string;
    awsWebsiteBucketPrefix: string;
    enableFirewall: boolean;
    throttlingConfig: TPSCalculationParams;
    devWebsiteUsername?: string;
    devWebsitePassword?: string;
}

export class ImageGenStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ImageGenStackProps) {
        super(scope, id, props);

        /* CONSTANTS */
        const allowedOrigin = `https://${props.domainName}`;

        /* SSL CERTIFICATES - CUSTOM DOMAINS */
        // Create SSL certificate for the domain
        const websiteCertificate = new acm.Certificate(this, "Certificate", {
            domainName: props.domainName,
            validation: acm.CertificateValidation.fromDns(),
        });
        const apiCertificate = new acm.Certificate(this, "ApiCertificate", {
            domainName: props.apiDomainName,
            validation: acm.CertificateValidation.fromDns(),
        });

        /* S3 BUCKETS - WEBSITE BUCKET */
        // Website bucket for static files
        const websiteBucket = new s3.Bucket(this, "ImageGenWebsiteBucket", {
            bucketName: `${props.awsWebsiteBucketPrefix}-${this.account}-${props.stageName}`, // Make unique per account
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        });

        /* S3 BUCKETS - INPUT BUCKET */
        // Input bucket for image inputs
        const inputBucket = new s3.Bucket(this, "ImageGenInputBucket", {
            bucketName: `${props.awsInputBucketPrefix}-${this.account}-${props.stageName}`, // Make unique per account
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            transferAcceleration: true,
            versioned: true,
            lifecycleRules: [
                {
                    // Create strict bucket TTL policy
                    // Minimum is 1 day
                    // No need to store users' input images for more than a day
                    expiration: cdk.Duration.days(1),
                    id: "DeleteAfterOneDay",
                    // Ensure noncurrent versions are also deleted
                    noncurrentVersionExpiration: cdk.Duration.days(1),
                    // Cleanup incomplete multipart uploads
                    abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
                },
                {
                    // Separate rule for expired object delete markers
                    id: "CleanupExpiredDeleteMarkers",
                    // Enable expiration of delete markers with no noncurrent versions
                    expiredObjectDeleteMarker: true,
                },
            ],
        });
        // Upload restriction - CORS origin
        inputBucket.addCorsRule({
            allowedMethods: [
                s3.HttpMethods.PUT,
                s3.HttpMethods.POST,
                // s3.HttpMethods.GET,
                // s3.HttpMethods.HEAD,
            ],
            allowedOrigins: [allowedOrigin],
            allowedHeaders: ["*"],
            exposedHeaders: ["ETag"],
            maxAge: 3000,
        });

        /* S3 BUCKETS - OUTPUT BUCKET */
        // Output bucket for generated images
        const outputBucket = new s3.Bucket(this, "ImageGenOutputBucket", {
            bucketName: `${props.awsOutputBucketPrefix}-${this.account}-${props.stageName}`, // Make unique per account
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            transferAcceleration: true,
            versioned: true,
            lifecycleRules: [
                {
                    // Create strict bucket TTL policy
                    // Minimum is 1 day
                    // RunPods requests disappear after 30 min, so we can't query them from /status
                    // endpoint after 30 min. So the CDN cache & bucket TTL determine how long the
                    // image persists past 30 min. We can be strict and only allow the image to be
                    // accessible for 24-30 hours (24 min, 30 max) via 6 hour cache & 1 day bucket TTL.
                    // See CloudFront section below.
                    expiration: cdk.Duration.days(1),
                    id: "DeleteAfterOneDay",
                    // Ensure noncurrent versions are also deleted
                    noncurrentVersionExpiration: cdk.Duration.days(1),
                    // Cleanup incomplete multipart uploads
                    abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
                },
                {
                    // Separate rule for expired object delete markers
                    id: "CleanupExpiredDeleteMarkers",
                    // Enable expiration of delete markers with no noncurrent versions
                    expiredObjectDeleteMarker: true,
                },
            ],
        });

        /* S3 BUCKETS - PERMISSIONS */
        // IAM user for worker to uploading output bucket & read from input bucket
        const workerUser = new iam.User(this, "ImageGenWorkerUser");
        // Create access key and store in Secrets Manager
        const workerUserAccessKey = new iam.AccessKey(
            this,
            "ImageGenWorkerUserAccessKey",
            {
                user: workerUser,
            }
        );
        const workerUserCredentialsSecret = new secretsmanager.Secret(
            this,
            "ImageGenWorkerUserUploadCredentials",
            {
                description: `AWS credentials for image gen worker's S3 upload & downlaod access in ${props.stageName}`,
                secretObjectValue: {
                    accessKeyId: cdk.SecretValue.unsafePlainText(
                        workerUserAccessKey.accessKeyId
                    ),
                    secretAccessKey: workerUserAccessKey.secretAccessKey,
                },
            }
        );
        // Grant download permissions
        inputBucket.grantRead(workerUser);
        // Grant upload permissions
        outputBucket.grantWrite(workerUser);

        /* CLOUDFRONT CDN - ORIGINS */
        // CloudFront distribution origins & access identities
        const websiteOrigin = new origins.S3Origin(websiteBucket, {
            originAccessIdentity: new cloudfront.OriginAccessIdentity(
                this,
                `WebsiteBucketOAI`,
                {
                    comment: `OAI for CloudFront -> S3 Bucket ${websiteBucket.bucketName}`,
                }
            ),
        });
        const outputOrigin = new origins.S3Origin(outputBucket, {
            originPath: "",
            originAccessIdentity: new cloudfront.OriginAccessIdentity(
                this,
                `OutputBucketOAI`,
                {
                    comment: `OAI for CloudFront -> S3 Bucket ${outputBucket.bucketName}`,
                }
            ),
        });

        /* CLOUDFRONT CDN - URL REWRITES & DEV ENV ACCESS */
        // Create CloudFront Function for url rewrites and basic auth when in dev stage
        let viewerRequestFunction: cloudfront.Function | undefined;
        if (props.stageName === "dev") {
            // Base64 encode the credentials
            const credentials = Buffer.from(
                `${props.devWebsiteUsername}:${props.devWebsitePassword}`
            ).toString("base64");

            viewerRequestFunction = new cloudfront.Function(
                this,
                `ViewerRequestFunction`,
                {
                    code: cloudfront.FunctionCode.fromInline(`
                        function handler(event) {
                            var request = event.request;
                            var headers = request.headers;
                            var uri = request.uri;

                            /* Basic auth */
                            // Check for Basic auth header
                            if (!headers.authorization) {
                                return {
                                    statusCode: 401,
                                    statusDescription: 'Unauthorized',
                                    headers: {
                                        'www-authenticate': { value: 'Basic' }
                                    }
                                };
                            }
                            // Verify credentials
                            var authHeader = headers.authorization.value;
                            var expectedHeader = 'Basic ${credentials}';
                            if (authHeader !== expectedHeader) {
                                return {
                                    statusCode: 401,
                                    statusDescription: 'Unauthorized',
                                    headers: {
                                        'www-authenticate': { value: 'Basic' }
                                    }
                                };
                            }

                            /* URL rewrites */
                            // Only rewrite if not root or file
                            if (uri !== '/' && !uri.includes('.')) {
                                // Redirect /folder -> /folder/
                                if (!uri.endsWith('/')) {
                                    uri += '/';
                                }
                                // Rewrite /folder/ -> /folder/index.html
                                if (uri.endsWith('/')) {
                                    uri += 'index.html';
                                }
                            }
                            // Update request.uri
                            request.uri = uri;
                            
                            return request;
                        }
                    `),
                }
            );
        } else {
            viewerRequestFunction = new cloudfront.Function(
                this,
                `ViewerRequestFunction`,
                {
                    code: cloudfront.FunctionCode.fromInline(`
                        function handler(event) {
                            var request = event.request;
                            var uri = request.uri;

                            /* URL rewrites */
                            // Only rewrite if not root or file
                            if (uri !== '/' && !uri.includes('.')) {
                                // Redirect /folder -> /folder/
                                if (!uri.endsWith('/')) {
                                    uri += '/';
                                }
                                // Rewrite /folder/ -> /folder/index.html
                                if (uri.endsWith('/')) {
                                    uri += 'index.html';
                                }
                            }
                            // Update request.uri
                            request.uri = uri;

                            return request;
                        }
                    `),
                }
            );
        }

        /* CLOUDFRONT CDN - CACHING POLICY */
        // Create strict image caching policy
        // RunPods requests disappear after 30 min, so we can't query them from /status
        // endpoint after 30 min. So the CDN cache & bucket TTL determine how long the
        // image persists past 30 min. We can be strict and only allow the image to be
        // accessible for 24-30 hours (24 min, 30 max) via 6 hour cache & 1 day bucket TTL.
        // See S3 bucket section above.
        const imageCachePolicy = new cloudfront.CachePolicy(
            this,
            "ImageCachePolicy",
            {
                comment: "Policy for image content",
                defaultTtl: cdk.Duration.hours(6),
                minTtl: cdk.Duration.hours(6),
                maxTtl: cdk.Duration.hours(6),
                enableAcceptEncodingGzip: true,
                enableAcceptEncodingBrotli: true,
            }
        );

        /* CLOUDFRONT CDN - DISTRIBUTION */
        // Create CloudFront distribution
        const distribution = new cloudfront.Distribution(
            this,
            `WebsiteDistribution`,
            {
                defaultBehavior: {
                    origin: websiteOrigin,
                    viewerProtocolPolicy:
                        cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
                    originRequestPolicy:
                        cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
                    responseHeadersPolicy:
                        cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
                    functionAssociations: [
                        {
                            function: viewerRequestFunction,
                            eventType:
                                cloudfront.FunctionEventType.VIEWER_REQUEST,
                        },
                    ],
                },
                additionalBehaviors: {
                    "/output/*": {
                        origin: outputOrigin,
                        viewerProtocolPolicy:
                            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                        allowedMethods:
                            cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
                        compress: true,
                        cachePolicy: imageCachePolicy,
                        originRequestPolicy:
                            cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
                        responseHeadersPolicy:
                            cloudfront.ResponseHeadersPolicy
                                .CORS_ALLOW_ALL_ORIGINS,
                        functionAssociations: [
                            {
                                function: viewerRequestFunction,
                                eventType:
                                    cloudfront.FunctionEventType.VIEWER_REQUEST,
                            },
                        ],
                    },
                },
                priceClass:
                    props.stageName === "dev"
                        ? cloudfront.PriceClass.PRICE_CLASS_100
                        : cloudfront.PriceClass.PRICE_CLASS_ALL,
                domainNames: [props.domainName],
                certificate: websiteCertificate,
                defaultRootObject: "index.html",
                errorResponses: [
                    {
                        httpStatus: 403,
                        responseHttpStatus: 403,
                        responsePagePath: "/errors/403.html",
                    },
                    {
                        httpStatus: 404,
                        responseHttpStatus: 404,
                        responsePagePath: "/errors/404.html",
                    },
                ],
            }
        );

        /* LAMBDA - APIS */
        // Create Lambda function for generating pre-signed URLs
        const uploadUrlLambda = new nodejs.NodejsFunction(
            this,
            "UploadUrlLambda",
            {
                runtime: lambda.Runtime.NODEJS_18_X,
                code: lambda.Code.fromAsset(
                    path.join(__dirname, "../lambdas/get-upload-url")
                ),
                handler: "main.handler",
                environment: {
                    S3_BUCKET_NAME: inputBucket.bucketName,
                    ALLOWED_ORIGIN: allowedOrigin,
                },
                bundling: {
                    minify: true,
                    sourceMap: true,
                    forceDockerBundling: true, // Force Docker bundling
                    nodeModules: [
                        "@aws-sdk/client-s3",
                        "@aws-sdk/s3-request-presigner",
                    ],
                },
                timeout: cdk.Duration.seconds(10),
            }
        );
        // Grant the Lambda permissions to generate pre-signed URLs for the input bucket
        uploadUrlLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ["s3:PutObject"],
                resources: [`${inputBucket.bucketArn}/*`],
                effect: iam.Effect.ALLOW,
            })
        );

        /* API GATEWAY - CORS CONFIG */
        const apiCorsConfig = {
            allowOrigins: [allowedOrigin],
            allowMethods: ["GET", "POST"],
            allowHeaders: [
                "Content-Type",
                "Authorization",
                "X-Amz-Date",
                "X-Amz-Security-Token",
                "X-Api-Key",
                "x-amz-content-sha256",
            ],
            maxAge: cdk.Duration.minutes(10),
            allowCredentials: true,
        };
        const getCORSResponseParametersForAPIGateway = () => {
            return {
                "Access-Control-Allow-Origin": `'${allowedOrigin}'`,
                "Access-Control-Allow-Headers":
                    "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,x-amz-content-sha256'",
                "Access-Control-Allow-Methods": "'POST,OPTIONS'",
                "Access-Control-Allow-Credentials": "'true'",
            };
        };
        const getCORSResponseParametersForMethodResponse = () => {
            return {
                "method.response.header.Access-Control-Allow-Origin": true,
                "method.response.header.Access-Control-Allow-Headers": true,
                "method.response.header.Access-Control-Allow-Methods": true,
                "method.response.header.Access-Control-Allow-Credentials": true,
            };
        };
        const apiGatewayResponseTypes = [
            { name: "Response400", type: apigateway.ResponseType.DEFAULT_4XX },
            { name: "Response401", type: apigateway.ResponseType.DEFAULT_4XX },
            { name: "Response403", type: apigateway.ResponseType.DEFAULT_4XX },
            { name: "Response404", type: apigateway.ResponseType.DEFAULT_4XX },
            { name: "Response429", type: apigateway.ResponseType.DEFAULT_4XX },
            { name: "Response500", type: apigateway.ResponseType.DEFAULT_5XX },
        ];
        const apiGatewayStatusCodes = [
            "200",
            "204",
            "400",
            "401",
            "403",
            "404",
            "405",
            "429",
            "500",
        ];

        /* API GATEWAY - DEFINITION */
        // Log group
        const apiAccessLogGroup = new logs.LogGroup(
            this,
            "ApiGatewayAccessLogs",
            {
                retention: logs.RetentionDays.ONE_WEEK,
            }
        );
        const api = new apigateway.RestApi(this, "ImageGenApi", {
            restApiName: `ImageGenerationAPI-${this.account}-${props.stageName}`,
            defaultCorsPreflightOptions: apiCorsConfig,
            defaultMethodOptions: {
                authorizationType: apigateway.AuthorizationType.IAM,
            },
            endpointConfiguration: {
                types: [apigateway.EndpointType.REGIONAL],
            },
            deployOptions: {
                stageName: props.stageName,
                dataTraceEnabled: true,
                loggingLevel: apigateway.MethodLoggingLevel.INFO,
                accessLogDestination: new apigateway.LogGroupLogDestination(
                    apiAccessLogGroup
                ),
                accessLogFormat:
                    apigateway.AccessLogFormat.jsonWithStandardFields({
                        caller: true,
                        httpMethod: true,
                        ip: true,
                        protocol: true,
                        requestTime: true,
                        resourcePath: true,
                        responseLength: true,
                        status: true,
                        user: true,
                    }),
            },
        });
        apiGatewayResponseTypes.forEach(({ name, type }) => {
            api.addGatewayResponse(name, {
                type,
                responseHeaders: getCORSResponseParametersForAPIGateway(),
            });
        });
        const apiDefinition = new apigateway.Model(this, "ApiDefinition", {
            restApi: api,
            contentType: "application/json",
            modelName: "ApiDefinition",
            schema: {
                type: apigateway.JsonSchemaType.OBJECT,
                properties: {
                    input: {
                        type: apigateway.JsonSchemaType.OBJECT,
                        properties: {
                            prompt: { type: apigateway.JsonSchemaType.STRING },
                            workflow: {
                                type: apigateway.JsonSchemaType.STRING,
                            },
                            aspect_ratio: {
                                type: apigateway.JsonSchemaType.STRING,
                            },
                        },
                        required: ["prompt"],
                    },
                },
            },
        });

        /* API GATEWAY - INTEGRATIONS */
        const runpodsRunIntegration = new apigateway.HttpIntegration(
            `${props.runpodsEndpoint}/run`,
            {
                httpMethod: "POST",
                options: {
                    requestParameters: {
                        "integration.request.header.Authorization": `'Bearer ${props.runpodsApiKey}'`,
                    },
                    requestTemplates: {
                        "application/json": `{
                            "input": $input.json('$.input')
                        }`,
                    },
                },
            }
        );
        const runpodsStatusIntegration = new apigateway.HttpIntegration(
            `${props.runpodsEndpoint}/status/{jobId}`,
            {
                httpMethod: "GET",
                options: {
                    requestParameters: {
                        "integration.request.header.Authorization": `'Bearer ${props.runpodsApiKey}'`,
                        "integration.request.path.jobId":
                            "method.request.path.jobId",
                    },
                },
            }
        );
        const uploadUrlLambdaIntegration = new apigateway.LambdaIntegration(
            uploadUrlLambda
        );

        /* API GATEWAY - REQUEST HANDLERS */
        // POST /run endpoint
        const runResource = api.root.addResource("run");
        // Request model for validation
        const runRequestModel = api.addModel("RunRequestModel", {
            contentType: "application/json",
            modelName: `RunRequestModel${this.account}${props.stageName}`,
            schema: {
                type: apigateway.JsonSchemaType.OBJECT,
                required: ["input"],
                properties: {
                    input: {
                        type: apigateway.JsonSchemaType.OBJECT,
                        required: ["prompt"],
                        properties: {
                            prompt: { type: apigateway.JsonSchemaType.STRING },
                            workflow: {
                                type: apigateway.JsonSchemaType.STRING,
                            },
                            aspect_ratio: {
                                type: apigateway.JsonSchemaType.STRING,
                            },
                            input_filename: {
                                type: apigateway.JsonSchemaType.STRING,
                            },
                            output_format: {
                                type: apigateway.JsonSchemaType.STRING,
                            },
                        },
                    },
                },
            },
        });
        const runMethod = runResource.addMethod("POST", runpodsRunIntegration, {
            requestModels: {
                "application/json": runRequestModel,
            },
            requestValidator: new apigateway.RequestValidator(
                this,
                `RunRequestValidator`,
                {
                    restApi: api,
                    validateRequestBody: true,
                }
            ),
        });
        // GET /status/{jobId} endpoint
        const statusResource = api.root
            .addResource("status")
            .addResource("{jobId}");
        const statusMethod = statusResource.addMethod(
            "GET",
            runpodsStatusIntegration,
            {
                requestParameters: {
                    "method.request.path.jobId": true,
                },
                // methodResponses: [{ statusCode: "200" }],
            }
        );
        // POST /upload endpoint
        // Create API resource and method for getting pre-signed URLs
        const uploadUrlResource = api.root.addResource("upload");
        const uploadRequestModel = api.addModel("UploadRequestModel", {
            contentType: "application/json",
            modelName: `UploadRequestModel${this.account}${props.stageName}`,
            schema: {
                type: apigateway.JsonSchemaType.OBJECT,
                required: ["fileName", "fileType"],
                properties: {
                    fileName: {
                        type: apigateway.JsonSchemaType.STRING,
                        pattern: `^[a-zA-Z0-9_\\-.: ]+\\.(${ALLOWED_FILE_EXTENSIONS})$`, // Allow only certain file extensions
                    },
                    fileType: {
                        type: apigateway.JsonSchemaType.STRING,
                        enum: ALLOWED_UPLOAD_TYPES, // Only allow specific MIME types
                    },
                },
            },
        });
        const uploadUrlMethodResponses = apiGatewayStatusCodes.map(
            (statusCode) => ({
                statusCode,
                responseParameters:
                    getCORSResponseParametersForMethodResponse(),
            })
        );
        const uploadUrlMethod = uploadUrlResource.addMethod(
            "POST",
            uploadUrlLambdaIntegration,
            {
                requestModels: {
                    "application/json": uploadRequestModel,
                },
                requestValidator: new apigateway.RequestValidator(
                    this,
                    `UploadRequestValidator`,
                    {
                        restApi: api,
                        validateRequestBody: true,
                    }
                ),
                methodResponses: uploadUrlMethodResponses,
            }
        );

        /* API GATEWAY - CUSTOM DOMAINS */
        // Create the custom domain in API Gateway
        const apiCustomDomain = new apigateway.DomainName(
            this,
            "CustomDomainName",
            {
                domainName: props.apiDomainName,
                certificate: apiCertificate,
                endpointType: apigateway.EndpointType.REGIONAL,
                securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
            }
        );
        // Map the custom domain to your API's stage
        new apigateway.BasePathMapping(this, "ApiMapping", {
            restApi: api,
            stage: api.deploymentStage,
            domainName: apiCustomDomain,
        });

        /* API GATEWAY - GUEST ACCESS */
        // Secure the API with Cognito
        const identityPool = new cognito.CfnIdentityPool(
            this,
            "ImageGenIdentityPool",
            {
                allowUnauthenticatedIdentities: true,
            }
        );
        // Create IAM role for unauthenticated access
        const unauthRole = new iam.Role(this, "CognitoUnauthRole", {
            assumedBy: new iam.FederatedPrincipal(
                "cognito-identity.amazonaws.com",
                {
                    StringEquals: {
                        "cognito-identity.amazonaws.com:aud": identityPool.ref,
                    },
                    "ForAnyValue:StringLike": {
                        "cognito-identity.amazonaws.com:amr": "unauthenticated",
                    },
                },
                "sts:AssumeRoleWithWebIdentity"
            ),
        });
        // Add execute-api permission to role
        unauthRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["execute-api:Invoke"],
                resources: [
                    // POST methods
                    `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/${api.deploymentStage.stageName}/POST/upload`,
                    `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/${api.deploymentStage.stageName}/POST/run`,
                    // OPTIONS preflight for POST methods
                    `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/${api.deploymentStage.stageName}/OPTIONS/upload`,
                    `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/${api.deploymentStage.stageName}/OPTIONS/run`,
                    // GET methods
                    `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/${api.deploymentStage.stageName}/GET/status/*`,
                    // OPTIONS preflight for GET methods
                    `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/${api.deploymentStage.stageName}/OPTIONS/status/*`,
                ],
            })
        );
        // Add S3 upload permission to role
        unauthRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:PutObject"],
                resources: [`${inputBucket.bucketArn}/*`],
                conditions: {
                    // Limit max file size to 5MB
                    NumericLessThan: {
                        "s3:content-length": FIVE_MIB_BYTES, // 5MB
                    },
                    // Restrict based on content type
                    StringLike: {
                        "s3:content-type": ["image/png", "image/jpeg"],
                    },
                    // Allow unsigned payload (for pre-signed URL pattern)
                    StringEquals: {
                        "s3:x-amz-content-sha256": "UNSIGNED-PAYLOAD",
                        "s3:RequestObjectTagKeys": [],
                    },
                },
            })
        );
        // Set roles on identity pool
        new cognito.CfnIdentityPoolRoleAttachment(
            this,
            "IdentityPoolRoleAttachment",
            {
                identityPoolId: identityPool.ref,
                roles: {
                    unauthenticated: unauthRole.roleArn,
                },
            }
        );

        /* API GATEWAY - THROTTLING */
        const apiLimits = calculateTPS(props.throttlingConfig);
        // Create usage plan with throttling settings
        const usagePlan = api.addUsagePlan("ImageGenApiUsagePlan", {
            name: `ImageGenApiUsagePlan-${props.stageName}`,
            throttle: {
                rateLimit: Math.max(
                    apiLimits.limits.runTPS,
                    apiLimits.limits.statusTPS
                ),
                burstLimit: Math.max(
                    apiLimits.limits.runTPSBurst,
                    apiLimits.limits.statusTPSBurst
                ),
            },
        });
        // Add the API stage to the usage plan with method-level throttling
        usagePlan.addApiStage({
            stage: api.deploymentStage,
            throttle: [
                {
                    method: runMethod,
                    throttle: {
                        rateLimit: apiLimits.limits.runTPS,
                        burstLimit: apiLimits.limits.runTPSBurst,
                    },
                },
                {
                    method: statusMethod,
                    throttle: {
                        rateLimit: apiLimits.limits.statusTPS,
                        burstLimit: apiLimits.limits.statusTPSBurst,
                    },
                },
                {
                    method: uploadUrlMethod,
                    throttle: {
                        rateLimit: apiLimits.limits.runTPS,
                        burstLimit: apiLimits.limits.runTPSBurst,
                    },
                },
            ],
        });

        /* API GATEWAY - IP-LEVEL THROTTLING */
        // Create WAF Firewall Web ACL with IP-based rate limiting
        let wafIPRateLimit, wafAssociation;
        if (props.enableFirewall) {
            wafIPRateLimit = new wafv2.CfnWebACL(this, "APIWafIPRateLimit", {
                defaultAction: { allow: {} },
                scope: "REGIONAL",
                name: `ImageGenAPIWaf-${props.stageName}`,
                visibilityConfig: {
                    cloudWatchMetricsEnabled: true,
                    metricName: "ImageGenAPIWafMetrics",
                    sampledRequestsEnabled: true,
                },
                rules: [
                    {
                        name: "IPRateLimitRun",
                        priority: 1,
                        statement: {
                            rateBasedStatement: {
                                limit: apiLimits.limits.ipRunLimit,
                                aggregateKeyType: "IP",
                                scopeDownStatement: {
                                    byteMatchStatement: {
                                        fieldToMatch: {
                                            uriPath: {},
                                        },
                                        positionalConstraint: "ENDS_WITH",
                                        searchString: "/run",
                                        textTransformations: [
                                            { priority: 1, type: "NONE" },
                                        ],
                                    },
                                },
                            },
                        },
                        visibilityConfig: {
                            cloudWatchMetricsEnabled: true,
                            metricName: "IPRateLimitRun",
                            sampledRequestsEnabled: true,
                        },
                        action: { block: {} },
                    },
                    {
                        name: "IPRateLimitStatus",
                        priority: 2,
                        statement: {
                            rateBasedStatement: {
                                limit: apiLimits.limits.ipStatusLimit,
                                aggregateKeyType: "IP",
                                scopeDownStatement: {
                                    byteMatchStatement: {
                                        fieldToMatch: {
                                            uriPath: {},
                                        },
                                        positionalConstraint: "CONTAINS",
                                        searchString: "/status/",
                                        textTransformations: [
                                            { priority: 1, type: "NONE" },
                                        ],
                                    },
                                },
                            },
                        },
                        visibilityConfig: {
                            cloudWatchMetricsEnabled: true,
                            metricName: "IPRateLimitStatus",
                            sampledRequestsEnabled: true,
                        },
                        action: { block: {} },
                    },
                    {
                        name: "IPRateLimitUpload",
                        priority: 3,
                        statement: {
                            rateBasedStatement: {
                                limit: apiLimits.limits.ipRunLimit,
                                aggregateKeyType: "IP",
                                scopeDownStatement: {
                                    byteMatchStatement: {
                                        fieldToMatch: {
                                            uriPath: {},
                                        },
                                        positionalConstraint: "ENDS_WITH",
                                        searchString: "/upload",
                                        textTransformations: [
                                            { priority: 1, type: "NONE" },
                                        ],
                                    },
                                },
                            },
                        },
                        visibilityConfig: {
                            cloudWatchMetricsEnabled: true,
                            metricName: "IPRateLimitRun",
                            sampledRequestsEnabled: true,
                        },
                        action: { block: {} },
                    },
                ],
            });
            // Associate WAF Firewall with API Gateway stage
            wafAssociation = new wafv2.CfnWebACLAssociation(
                this,
                "WafAssociation",
                {
                    resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${api.restApiId}/stages/${api.deploymentStage.stageName}`,
                    webAclArn: wafIPRateLimit.attrArn,
                }
            );
        }

        /* STACK OUTPUTS */
        new cdk.CfnOutput(this, "CertificateValidationRecords", {
            value:
                "IMPORTANT!! Check Certificate Manager in AWS Console for DNS validation records to add to external DNS provider ie. Namecheap, GoDaddy, Yandex. " +
                "Initial stack deployment won't complete until the DNS is updated & propagates (which takes a while).",
            description:
                "DNS records needed for website SSL certificate validation",
        });
        new cdk.CfnOutput(this, "ApiCertificateValidationRecords", {
            value:
                "IMPORTANT!! Check Certificate Manager for DNS validation records for images-api-dev.anuv.me to add to external DNS provider ie. Namecheap, GoDaddy, Yandex. " +
                "Initial stack deployment won't complete until the DNS is updated & propagates (which takes a while).",
            description:
                "DNS records needed for API SSL certificate validation",
        });
        new cdk.CfnOutput(this, "CloudFrontDomainSetup", {
            value: `DNS Record:\nDomain: ${props.domainName}\nType: CNAME\nTarget: ${distribution.distributionDomainName}`,
            description:
                "CloudFront Domain CNAME record to add in external DNS provider ie. Namecheap, GoDaddy, Yandex",
        });
        new cdk.CfnOutput(this, "ApiDomainSetup", {
            value: `DNS Record:\nDomain: ${props.apiDomainName}\nType: CNAME\nTarget: ${apiCustomDomain.domainNameAliasDomainName}`,
            description:
                "API Gateway Domain CNAME record to add in external DNS provider ie. Namecheap, GoDaddy, Yandex",
        });
        new cdk.CfnOutput(this, "CloudFrontDistributionId", {
            value: distribution.distributionId,
            description: "CloudFront Distribution ID",
        });
        new cdk.CfnOutput(this, "WorkerUserCredentialsSecretArn", {
            value: workerUserCredentialsSecret.secretArn,
            description:
                "ARN of the secret containing worker S3 upload/download credentials",
        });
        new cdk.CfnOutput(this, "ApiUrl", {
            value: api.url,
            description: "URL of the API Gateway endpoint",
        });
        new cdk.CfnOutput(this, "IdentityPoolId", {
            value: identityPool.ref,
            description:
                "ID of the Cognito Identity Pool for frontend authentication",
        });
        new cdk.CfnOutput(this, "WafWebACLArn", {
            value:
                props.enableFirewall && wafIPRateLimit
                    ? wafIPRateLimit.attrArn
                    : "N/A (Firewall not enabled)",
            description: "ARN of the WAF Web ACL for IP-based rate limiting",
        });
        new cdk.CfnOutput(this, "InputBucketName", {
            value: inputBucket.bucketName,
            description: "Bucket name for storing input images",
        });
        new cdk.CfnOutput(this, "OutputBucketName", {
            value: outputBucket.bucketName,
            description: "Bucket name for storing generated images",
        });
        new cdk.CfnOutput(this, "WebsiteBucketName", {
            value: websiteBucket.bucketName,
            description: "Bucket name for website files",
        });
        new cdk.CfnOutput(this, "MaxConcurrentUsers", {
            value: `${apiLimits.details.metrics.maxSupportedUsers} users / sec`,
            description: `Maximum concurrent users per second supported, calculated from maxWorkers=${apiLimits.inputs.maxWorkers}, generationTimeSeconds=${apiLimits.inputs.generationTimeSeconds}, statusPollIntervalSeconds=${apiLimits.inputs.statusPollIntervalSeconds}, imagesPerSession=${apiLimits.inputs.imagesPerSession}, averageThinkTimeSeconds=${apiLimits.inputs.averageThinkTimeSeconds}`,
        });
        new cdk.CfnOutput(this, "TPSLimits", {
            value: `runTPS=${apiLimits.limits.runTPS}tps, runTPSBurst=${apiLimits.limits.runTPSBurst}tps, ipRunLimit=${apiLimits.limits.ipRunLimit} runs per ${apiLimits.inputs.ipLimitWindowMinutes}min, statusTPS=${apiLimits.limits.statusTPS}tps, statusTPSBurst=${apiLimits.limits.statusTPSBurst}tps, ipStatusLimit=${apiLimits.limits.ipStatusLimit} status checks per ${apiLimits.inputs.ipLimitWindowMinutes}min`,
            description: `TPS limits, calculated from maxWorkers=${apiLimits.inputs.maxWorkers}, generationTimeSeconds=${apiLimits.inputs.generationTimeSeconds}, statusPollIntervalSeconds=${apiLimits.inputs.statusPollIntervalSeconds}, imagesPerSession=${apiLimits.inputs.imagesPerSession}, averageThinkTimeSeconds=${apiLimits.inputs.averageThinkTimeSeconds}`,
        });
    }
}
